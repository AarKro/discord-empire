/**
 * world:init (§9 boot registration, run manually) — idempotent dev-world setup.
 *
 * For every continent guild: ensure the public bazaar channels exist, map them
 * in `locations` (the DB is the position truth; Discord only reflects it), and
 * seed the NPC row + shop stock. Safe to rerun: existing channels are reused
 * and inventory is only inserted where no row exists, so restocking a sold-out
 * item never happens by accident here.
 *
 * Lives in core because it talks to discord.js (the "only core" invariant);
 * bots invoke it through a thin runner (`pnpm world:init`).
 */
import { ChannelType, Client, GatewayIntentBits, type Guild, type GuildBasedChannel } from "discord.js";
import type { Continents, Districts, Shop } from "@empire/content-schemas";
import { jsonParam, type Sql } from "@empire/db";
import type { Logger } from "./logger.js";
import { rootLogger } from "./logger.js";
import { BUILD_PERMIT_ITEM } from "./capabilities/land.js";

/** A buildable recipe seeded into blueprint_catalog (§5.12, §10 Builder). */
export interface BlueprintSeed {
  id: string;
  name: string;
  costGold: number;
  baseMs: number;
}

/**
 * The default buildable catalog for iteration-1 dev. Costs are ≤100 so a fresh
 * 150-gold player can afford one. Build times are short so a dev can watch the
 * tick service complete them.
 */
export const DEFAULT_BLUEPRINTS: BlueprintSeed[] = [
  { id: "farm", name: "Wheat Farm", costGold: 50, baseMs: 300_000 }, // ~5m
  { id: "forge", name: "Blacksmith Forge", costGold: 100, baseMs: 600_000 }, // ~10m
];

export interface BootstrapOptions {
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
  /** Buildable recipes to seed; defaults to DEFAULT_BLUEPRINTS. */
  blueprints?: BlueprintSeed[];
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

/**
 * Seed a continent's districts (§2.2): each becomes a Discord category with a
 * view-role; non-starting districts are hidden behind that role (deny @everyone
 * ViewChannel, allow the role) so they stay invisible until discovered, while the
 * bazaar (starting) district is left public. Returns the bazaar district's DB id
 * (`<id>_<guildId>`) and moves the given channels under its category. Best-effort
 * on Discord ops — a missing Manage Roles/Channels logs and leaves the DB row.
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
  for (const def of defs) {
    const dbId = `${def.id}_${guildId}`;
    let category = channels.find((c) => c?.type === ChannelType.GuildCategory && c.name === def.name) ?? null;
    if (!category) category = await guild.channels.create({ name: def.name, type: ChannelType.GuildCategory });

    const roleName = `${def.name} Access`;
    const role = guild.roles.cache.find((r) => r.name === roleName) ?? (await guild.roles.create({ name: roleName, reason: "district view-role (§2.2)" }).catch(() => null));

    // Hide non-starting districts behind their view-role; the bazaar stays public.
    if (!def.holds_bazaar && role && category.type === ChannelType.GuildCategory) {
      await category.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }).catch((err) => log.warn({ err, district: dbId }, "hide district failed (need Manage Channels)"));
      await category.permissionOverwrites.edit(role.id, { ViewChannel: true }).catch(() => {});
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

export async function bootstrapWorld(opts: BootstrapOptions): Promise<void> {
  const log = (opts.logger ?? rootLogger).child({ component: "bootstrap" });
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await new Promise<void>((resolve) => {
    client.once("ready", () => resolve());
    void client.login(opts.token);
  });

  try {
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

      // The NPC's wander stops are voice channels (§5.1). Iteration 1 seeds two —
      // the Bazaar and the Market Square — keyed in `locations` by their logical
      // stop name (`<name>_<guildId>`, kind='voice') so presence.voice resolves
      // schedule stops like "bazaar_vc"/"market_square_vc" to real channels.
      const voiceStops: { name: string; display: string }[] = [
        { name: "bazaar_vc", display: "Bazaar" },
        { name: "market_square_vc", display: "Market Square" },
      ];
      const seededVoice: string[] = [];
      // Collect the public market channels (bazaar text + NPC voice stops) so the
      // district seeder can move them under the Market District category.
      const marketChannels: GuildBasedChannel[] = [bazaar];
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
          voice: seededVoice.join(", "),
          land: `${landCategory.id}${createdCategory ? " (created)" : " (found)"}`,
          districts: (opts.districts.districts[guildId] ?? []).map((d) => d.id).join(", "),
        },
        "bazaar + districts mapped",
      );
    }

    await opts.sql`
      INSERT INTO npcs (id, kind) VALUES (${opts.npcId}, 'merchant')
      ON CONFLICT (id) DO NOTHING
    `;

    let seeded = 0;
    for (const item of opts.shop.items) {
      const rows = await opts.sql`
        INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
        VALUES ('npc', ${opts.npcId}, ${item.item_id}, ${item.stock})
        ON CONFLICT (owner_kind, owner_id, item_id) DO NOTHING
        RETURNING item_id
      `;
      seeded += rows.length;
    }
    log.info({ npc: opts.npcId, seeded, items: opts.shop.items.length }, "npc + stock seeded (existing rows untouched)");

    // Seed the buildable catalog idempotently (§5.12, §10 Builder). Rerunnable:
    // ON CONFLICT DO NOTHING leaves any hand-tuned rows alone.
    const blueprints = opts.blueprints ?? DEFAULT_BLUEPRINTS;
    let blueprintsSeeded = 0;
    for (const blueprint of blueprints) {
      const rows = await opts.sql`
        INSERT INTO blueprint_catalog (id, name, cost_gold, base_ms)
        VALUES (${blueprint.id}, ${blueprint.name}, ${blueprint.costGold}, ${blueprint.baseMs})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      blueprintsSeeded += rows.length;
    }
    log.info({ seeded: blueprintsSeeded, total: blueprints.length }, "blueprint catalog seeded (existing rows untouched)");

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
        VALUES ('npc', ${opts.builderId}, ${BUILD_PERMIT_ITEM}, 1000000)
        ON CONFLICT (owner_kind, owner_id, item_id) DO NOTHING
      `;
      log.info({ builder: opts.builderId }, "builder npc + permit stock seeded");
    }
  } finally {
    await client.destroy();
  }
}
