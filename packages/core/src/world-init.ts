/**
 * `pnpm world:init` / `pnpm start`'s world step — idempotent dev-world bootstrap.
 * Compiled to dist/world-init.js and run with `node`. Decoupled from any bot app:
 * it just needs a Discord token with Manage Channels/Roles, and reuses the
 * merchant's token (MERCHANT_TOKEN) since that bot already has those perms.
 *
 * Contains the whole bootstrap (it's the only caller): for every continent guild
 * it ensures the public bazaar/marketplace channels + NPC voice stops exist, maps
 * them in `locations` (the DB is the position truth; Discord only reflects it),
 * seeds districts (categories + view-roles), and seeds the NPC/shop rows.
 * It talks to discord.js, which is allowed here (world-init lives in @empire/core).
 *
 * Idempotent — safe to rerun (reuses channels, never restocks). By default it
 * SKIPS when the world is already seeded (so `pnpm start` stays fast); pass
 * `--force` to re-run bootstrap after adding new world content.
 */
import { join } from "node:path";
import { ChannelType, Client, GatewayIntentBits, type Guild, type GuildBasedChannel } from "discord.js";
import { loadContentFile, Manifest, Shop, Continents, Districts } from "@empire/content-schemas";
import { openDb, jsonParam, type Sql } from "@empire/db";
import { rootLogger, type Logger } from "./logger.js";
import { BUILD_PERMIT_ITEM, RESEARCH_PERMIT_ITEM, MUSTER_PERMIT_ITEM } from "./world/items.js";
import { npcAt } from "./world/npc-identity.js";
import { regionOf, regionalItem, UNLIMITED_STOCK } from "./world/goods.js";

interface BootstrapOptions {
  token: string;
  sql: Sql;
  continents: Continents;
  /** Within-continent districts (§2.2) to seed as categories + view-roles. */
  districts: Districts;
  /** The NPC whose stall/stock is being seeded (iteration 1: "merchant"). */
  npcId: string;
  shop: Shop;
  /** The builder NPC that "sells" build permits (the cost sink). */
  builderId?: string;
  /** The Architect NPC that "sells" research permits (the cost sink). */
  architectId?: string;
  /** The Warden NPC that "sells" muster permits (the cost sink). */
  wardenId?: string;
  logger?: Logger;
}

/**
 * Idempotently map a location id to its Discord channel (§8 guild+channel map).
 * Rerunnable: re-points an existing row at the current channel AND its presence
 * flag (so a re-run flips the gate). Now that player travel exists (§9), the
 * bazaar gates on presence — you shop only where you stand; voice stops + the
 * land category don't (players never interact with them directly).
 */
async function upsertLocation(
  sql: Sql,
  loc: { id: string; guildId: string; channelId: string; kind: string; requiresPresence?: boolean; districtId?: string | null },
): Promise<void> {
  await sql`
    INSERT INTO locations (id, guild_id, channel_id, kind, requires_presence, district_id)
    VALUES (${loc.id}, ${loc.guildId}, ${loc.channelId}, ${loc.kind}, ${loc.requiresPresence ?? false}, ${loc.districtId ?? null})
    ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, requires_presence = EXCLUDED.requires_presence, district_id = EXCLUDED.district_id
  `;
}

/** Continent membership role names (§9 gatekeeper): full member vs. watcher. */
const CITIZEN_ROLE = "Citizen";
const OBSERVER_ROLE = "Observer";

/**
 * Seed a continent's districts (§2.2) and its membership roles (§9). Each district
 * becomes a Discord category with a view-role; non-starting districts are hidden
 * behind that role (deny @everyone ViewChannel, allow the role) so they stay
 * invisible until discovered. The bazaar (starting) district — the continent's
 * public face — is gated behind the continent's Citizen + Observer roles so an
 * undiscovered continent is invisible (§2.3). Managed (bot) roles are always
 * allowed ViewChannel so the deny-@everyone never blinds the bots. Also find-or-
 * creates the Citizen/Observer roles and records their ids in `continent_roles`.
 * Returns the bazaar district's DB id (`<id>_<guildId>`) and moves the given
 * channels under its category. Best-effort on Discord ops — a missing Manage
 * Roles/Channels logs and leaves the DB row.
 */
async function seedDistricts(
  sql: Sql,
  guild: Guild,
  guildId: string,
  defs: Districts["districts"][string],
  marketChannels: GuildBasedChannel[],
  log: Logger,
): Promise<string | null> {
  let bazaarDistrictId: string | null = null;
  const channels = await guild.channels.fetch();
  // Fetch roles explicitly (like channels) so the find-or-create below is truly
  // idempotent — a cold roles cache would otherwise recreate every view-role on
  // each world:init re-run and leak duplicates.
  const roles = await guild.roles.fetch();

  // Continent membership roles (§9 gatekeeper): find-or-create Citizen + Observer
  // (idempotent, like the district view-roles) and record their ids so the
  // gatekeeper capability can grant them.
  const citizen = roles.find((r) => r.name === CITIZEN_ROLE) ?? (await guild.roles.create({ name: CITIZEN_ROLE, reason: "continent Citizen role (§9)" }).catch(() => null));
  const observer = roles.find((r) => r.name === OBSERVER_ROLE) ?? (await guild.roles.create({ name: OBSERVER_ROLE, reason: "continent Observer role (§9)" }).catch(() => null));
  await sql`
    INSERT INTO continent_roles (guild_id, citizen_role_id, observer_role_id)
    VALUES (${guildId}, ${citizen?.id ?? null}, ${observer?.id ?? null})
    ON CONFLICT (guild_id) DO UPDATE SET citizen_role_id = EXCLUDED.citizen_role_id, observer_role_id = EXCLUDED.observer_role_id
  `;
  // Bots are guild members too, so any deny-@everyone ViewChannel below would also
  // blind them — allow every managed (bot/integration) role to keep them posting.
  const botRoleIds = roles.filter((r) => r.managed).map((r) => r.id);

  for (const def of defs) {
    const dbId = `${def.id}_${guildId}`;
    let category = channels.find((c) => c?.type === ChannelType.GuildCategory && c.name === def.name) ?? null;
    if (!category) category = await guild.channels.create({ name: def.name, type: ChannelType.GuildCategory });

    const roleName = `${def.name} Access`;
    const role = roles.find((r) => r.name === roleName) ?? (await guild.roles.create({ name: roleName, reason: "district view-role (§2.2)" }).catch(() => null));

    if (category.type === ChannelType.GuildCategory) {
      // The bazaar (public face) is gated behind Citizen + Observer; other districts
      // behind their own view-role. Either way @everyone is denied and bots allowed.
      const allowIds = (def.holds_bazaar ? [citizen?.id, observer?.id] : [role?.id]).concat(botRoleIds).filter((x): x is string => Boolean(x));
      await category.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }).catch((err) => log.warn({ err, district: dbId }, "gate district failed (need Manage Channels)"));
      for (const rid of allowIds) {
        await category.permissionOverwrites.edit(rid, { ViewChannel: true }).catch(() => {});
      }
    }

    const neighbors = def.neighbors.map((n) => `${n}_${guildId}`);
    await sql`
      INSERT INTO districts (id, guild_id, name, category_id, view_role_id, neighbors)
      VALUES (${dbId}, ${guildId}, ${def.name}, ${category.id}, ${role?.id ?? null}, ${jsonParam(sql, neighbors)})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category_id = EXCLUDED.category_id, view_role_id = EXCLUDED.view_role_id, neighbors = EXCLUDED.neighbors
    `;

    if (def.holds_bazaar) {
      bazaarDistrictId = dbId;
      for (const channel of marketChannels) {
        if (!("setParent" in channel)) continue; // threads can't be reparented; the market channels aren't threads
        await channel.setParent(category.id, { lockPermissions: true }).catch((err: unknown) => log.warn({ err, channel: channel.id }, "move channel to market district failed"));
      }
    }
  }
  return bazaarDistrictId;
}

/**
 * Phase 1 — every continent's Discord SURFACE, and the `locations` rows that map
 * it. For each guild: the bazaar + Marketplace + town-crier text channels, the
 * NPC voice stops, the districts (categories + view-roles + membership roles),
 * and the Land category player plots are created under.
 *
 * Idempotent throughout: channels and roles are found-or-created, and every
 * mapping is an upsert, so a re-run re-points existing rows rather than
 * duplicating anything.
 */
async function seedGuildSurfaces(client: Client, opts: BootstrapOptions, log: Logger): Promise<void> {
  for (const guildId of Object.keys(opts.continents.continents)) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      log.warn({ guildId }, "bot is not a member of this guild — invite it first; skipping");
      continue;
    }
    const channels = await guild.channels.fetch();

    let bazaar = channels.find((channel) => channel?.type === ChannelType.GuildText && channel.name === "bazaar") ?? null;
    let createdText = false;
    if (!bazaar) {
      bazaar = await guild.channels.create({ name: "bazaar", type: ChannelType.GuildText });
      createdText = true;
    }

    // The public Marketplace board (§5.11) — where player stall listings render.
    // Not presence-gated (the market is global); the exchange bot posts here.
    let marketplace = channels.find((channel) => channel?.type === ChannelType.GuildText && channel.name === "marketplace") ?? null;
    if (!marketplace) marketplace = await guild.channels.create({ name: "marketplace", type: ChannelType.GuildText });
    await upsertLocation(opts.sql, { id: `market_${guildId}`, guildId, channelId: marketplace.id, kind: "market" });

    // The town-crier (§9) — where the Herald mirrors realm-wide world.* notices
    // (auction results, leaderboard sweeps). Not presence-gated: it's world news,
    // visible to everyone on the continent, so it stays at guild root rather than
    // under a presence-gated district.
    let crier = channels.find((channel) => channel?.type === ChannelType.GuildText && channel.name === "town-crier") ?? null;
    if (!crier) crier = await guild.channels.create({ name: "town-crier", type: ChannelType.GuildText });
    await upsertLocation(opts.sql, { id: `crier_${guildId}`, guildId, channelId: crier.id, kind: "crier", requiresPresence: false });

    // The NPC's wander stops are voice channels (§5.1). Iteration 1 seeds two —
    // the Bazaar and the Market Square — keyed in `locations` by their logical
    // stop name (`<name>_<guildId>`, kind='voice') so presence.voice resolves
    // schedule stops like "bazaar_vc"/"market_square_vc" to real channels.
    const voiceStops: { name: string; display: string }[] = [
      { name: "bazaar_vc", display: "Bazaar" },
      { name: "market_square_vc", display: "Market Square" },
    ];
    const seededVoice: string[] = [];
    // Collect the public market channels (bazaar text + Marketplace board + NPC
    // voice stops) so the district seeder can move them under the Market District.
    const marketChannels: GuildBasedChannel[] = [bazaar, marketplace];
    for (const stop of voiceStops) {
      let voiceChannel = channels.find((channel) => channel?.type === ChannelType.GuildVoice && channel.name === stop.display) ?? null;
      let created = false;
      if (!voiceChannel) {
        voiceChannel = await guild.channels.create({ name: stop.display, type: ChannelType.GuildVoice });
        created = true;
      }
      await upsertLocation(opts.sql, { id: `${stop.name}_${guildId}`, guildId, channelId: voiceChannel.id, kind: "voice" });
      marketChannels.push(voiceChannel);
      seededVoice.push(`${stop.display}:${voiceChannel.id}${created ? " (created)" : " (found)"}`);
    }

    // Seed the continent's districts (§2.2): categories + view-roles, hiding the
    // non-starting ones and moving the market channels under the bazaar district.
    const bazaarDistrictId = await seedDistricts(opts.sql, guild, guildId, opts.districts.districts[guildId] ?? [], marketChannels, log);

    // The bazaar gates on presence (§9, §2.3): you shop only in the district you
    // stand in. A re-run flips the flag + district on existing rows.
    await upsertLocation(opts.sql, { id: `bazaar_${guildId}`, guildId, channelId: bazaar.id, kind: "bazaar", requiresPresence: true, districtId: bazaarDistrictId });

    // The "Land" category holds every player's plot channels (§2.4). The
    // builder bot creates per-plot text+voice channels under it at /build time,
    // so world:init just ensures the category exists and maps it in locations.
    let landCategory = channels.find((channel) => channel?.type === ChannelType.GuildCategory && channel.name === "Land") ?? null;
    let createdCategory = false;
    if (!landCategory) {
      landCategory = await guild.channels.create({ name: "Land", type: ChannelType.GuildCategory });
      createdCategory = true;
    }
    await upsertLocation(opts.sql, { id: `land_${guildId}`, guildId, channelId: landCategory.id, kind: "land" });

    log.info(
      {
        guild: guild.name,
        bazaar: `${bazaar.id}${createdText ? " (created)" : " (found)"}`,
        crier: crier.id,
        voice: seededVoice.join(", "),
        land: `${landCategory.id}${createdCategory ? " (created)" : " (found)"}`,
        districts: (opts.districts.districts[guildId] ?? []).map((d) => d.id).join(", "),
      },
      "bazaar + districts mapped",
    );
  }
}

/**
 * Phase 2 — the world's economy rows: the merchant NPC and its stock, and the
 * permit-sink NPCs whose "sales" model build, research and muster costs as
 * trades. (The blueprint, research and encounter CATALOGS are content — see
 * content/catalog/ — and are synced on boot by the bots that own them.)
 *
 * ON CONFLICT DO NOTHING throughout, so a re-run never restocks a shop.
 *
 * SHOP STOCK is per continent (§2.5): each
 * continent's persona keeps its own purse under `npcAt`, stocked deep in its own
 * region's wares and thin in everyone else's. The permit sinks stay global —
 * they are cost sinks, not geography.
 */
async function seedCatalogs(opts: BootstrapOptions, log: Logger): Promise<void> {
  // ONE npcs row per bot: `npcs` is bookkeeping identity (state, pins, wander
  // position), which does not fork per continent. Only the purse does.
  await opts.sql`
    INSERT INTO npcs (id, kind) VALUES (${opts.npcId}, 'merchant')
    ON CONFLICT (id) DO NOTHING
  `;

  let seeded = 0;
  for (const guildId of Object.keys(opts.continents.continents)) {
    const region = regionOf(opts.continents, guildId);
    for (const item of opts.shop.items) {
      const rows = await opts.sql`
        INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
        VALUES ('npc', ${npcAt(opts.npcId, guildId)}, ${item.item_id}, ${regionalItem(item, region).stock})
        ON CONFLICT (owner_kind, owner_id, item_id) DO NOTHING
        RETURNING item_id
      `;
      seeded += rows.length;
    }
  }
  log.info({ npc: opts.npcId, seeded, items: opts.shop.items.length }, "npc + per-continent stock seeded (existing rows untouched)");

  // The builder NPC "sells" build permits (the cost sink for /build). Seed the
  // NPC row and a large permit stock so the atomic trade always has stock; the
  // ledger write still goes through `trade`.
  if (opts.builderId) {
    await opts.sql`
      INSERT INTO npcs (id, kind) VALUES (${opts.builderId}, 'builder')
      ON CONFLICT (id) DO NOTHING
    `;
    await opts.sql`
      INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
      VALUES ('npc', ${opts.builderId}, ${BUILD_PERMIT_ITEM}, ${UNLIMITED_STOCK})
      ON CONFLICT (owner_kind, owner_id, item_id) DO NOTHING
    `;
    log.info({ builder: opts.builderId }, "builder npc + permit stock seeded");
  }

  // The Architect NPC "sells" research permits (the cost sink for /research),
  // mirroring the builder permit-sink so the atomic trade always has stock; the
  // ledger write still goes through `trade`.
  if (opts.architectId) {
    await opts.sql`
      INSERT INTO npcs (id, kind) VALUES (${opts.architectId}, 'architect')
      ON CONFLICT (id) DO NOTHING
    `;
    await opts.sql`
      INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
      VALUES ('npc', ${opts.architectId}, ${RESEARCH_PERMIT_ITEM}, ${UNLIMITED_STOCK})
      ON CONFLICT (owner_kind, owner_id, item_id) DO NOTHING
    `;
    log.info({ architect: opts.architectId }, "architect npc + permit stock seeded");
  }

  // The Warden NPC "sells" muster permits (the cost sink for /muster),
  // mirroring the builder and architect permit-sinks so the atomic trade always
  // has stock; the ledger write still goes through `trade`.
  if (opts.wardenId) {
    await opts.sql`
      INSERT INTO npcs (id, kind) VALUES (${opts.wardenId}, 'warden')
      ON CONFLICT (id) DO NOTHING
    `;
    await opts.sql`
      INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
      VALUES ('npc', ${opts.wardenId}, ${MUSTER_PERMIT_ITEM}, ${UNLIMITED_STOCK})
      ON CONFLICT (owner_kind, owner_id, item_id) DO NOTHING
    `;
    log.info({ warden: opts.wardenId }, "warden npc + permit stock seeded");
  }
}

async function bootstrapWorld(opts: BootstrapOptions): Promise<void> {
  const log = (opts.logger ?? rootLogger).child({ component: "bootstrap" });
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await new Promise<void>((resolve) => {
    client.once("ready", () => resolve());
    void client.login(opts.token);
  });

  try {
    await seedGuildSurfaces(client, opts, log);
    await seedCatalogs(opts, log);
  } finally {
    await client.destroy();
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const CONTENT_DIR = process.env.CONTENT_DIR ?? "content";
const force = process.argv.includes("--force");

/** Has the world ever been bootstrapped? bootstrap seeds a `locations` row per
 * guild, so any row means yes. A missing table (pre-migrate) counts as no. */
async function alreadySeeded(sql: Sql): Promise<boolean> {
  try {
    const rows = await sql`SELECT 1 FROM locations LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const manifest = loadContentFile(Manifest, join(CONTENT_DIR, "manifests/merchant.yaml"));
  const continents = loadContentFile(Continents, join(CONTENT_DIR, "continents.yaml"));
  const districts = loadContentFile(Districts, join(CONTENT_DIR, "districts.yaml"));
  const shop = loadContentFile(Shop, join(CONTENT_DIR, manifest.content?.shop ?? "shops/aldric.yaml"));
  // Seed the builder's cost-sink NPC under its real manifest id (the builder bot
  // trades as its manifest.id), so the two can never drift out of sync.
  const builderManifest = loadContentFile(Manifest, join(CONTENT_DIR, "manifests/builder.yaml"));
  // The Architect trades as its manifest id (like the builder), so seed its
  // cost-sink NPC under that same id — the two can never drift out of sync.
  const architectManifest = loadContentFile(Manifest, join(CONTENT_DIR, "manifests/architect.yaml"));
  // …and the Warden's muster permit-sink, on the same reasoning (§5.13).
  const wardenManifest = loadContentFile(Manifest, join(CONTENT_DIR, "manifests/warden.yaml"));

  // Bootstrap needs a token with Manage Channels/Roles; the merchant's has them.
  const token = process.env[manifest.token_env];
  if (!token) throw new Error(`${manifest.token_env} is required`);

  const { sql, close } = openDb(url);
  try {
    if (!force && (await alreadySeeded(sql))) {
      rootLogger.info("world already initialized — skipping (use --force to re-seed)");
      return;
    }
    await bootstrapWorld({
      token,
      sql,
      continents,
      districts,
      npcId: manifest.id,
      shop,
      // Iteration 1 seeds the Builder's cost-sink NPC + build permit stock here
      // too, so a single world:init covers both reference bots (§10). The
      // merchant token has Manage Channels, so it runs it.
      builderId: builderManifest.id,
      // Same for the Architect's research permit-sink NPC (§4).
      architectId: architectManifest.id,
      // …and the Warden's muster permit-sink NPC (§2.6, §5.13).
      wardenId: wardenManifest.id,
      logger: rootLogger,
    });
  } finally {
    await close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    rootLogger.error({ err }, "world:init failed");
    process.exit(1);
  });
