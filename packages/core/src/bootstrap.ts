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
import { ChannelType, Client, GatewayIntentBits } from "discord.js";
import type { Continents, Shop } from "@empire/content-schemas";
import type { Sql } from "@empire/db";
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
  /** The NPC whose stall/stock is being seeded (iteration 1: "merchant"). */
  npcId: string;
  shop: Shop;
  /** The builder NPC that "sells" build permits (the cost sink). */
  builderId?: string;
  /** Buildable recipes to seed; defaults to DEFAULT_BLUEPRINTS. */
  blueprints?: BlueprintSeed[];
  logger?: Logger;
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

      let bazaar = channels.find((c) => c?.type === ChannelType.GuildText && c.name === "bazaar") ?? null;
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
      for (const stop of voiceStops) {
        let vc = channels.find((c) => c?.type === ChannelType.GuildVoice && c.name === stop.display) ?? null;
        let created = false;
        if (!vc) {
          vc = await guild.channels.create({ name: stop.display, type: ChannelType.GuildVoice });
          created = true;
        }
        await opts.sql`
          INSERT INTO locations (id, guild_id, channel_id, kind, requires_presence)
          VALUES (${`${stop.name}_${guildId}`}, ${guildId}, ${vc.id}, 'voice', false)
          ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, requires_presence = EXCLUDED.requires_presence
        `;
        seededVoice.push(`${stop.display}:${vc.id}${created ? " (created)" : " (found)"}`);
      }

      // Iteration 1 has no travel yet, so the bazaar must not gate on position.
      await opts.sql`
        INSERT INTO locations (id, guild_id, channel_id, kind, requires_presence)
        VALUES (${`bazaar_${guildId}`}, ${guildId}, ${bazaar.id}, 'bazaar', false)
        ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, requires_presence = EXCLUDED.requires_presence
      `;

      // The "Land" category holds every player's plot channels (§2.4). The
      // builder bot creates per-plot text+voice channels under it at /build time,
      // so world:init just ensures the category exists and maps it in locations.
      let landCat = channels.find((c) => c?.type === ChannelType.GuildCategory && c.name === "Land") ?? null;
      let createdCat = false;
      if (!landCat) {
        landCat = await guild.channels.create({ name: "Land", type: ChannelType.GuildCategory });
        createdCat = true;
      }
      await opts.sql`
        INSERT INTO locations (id, guild_id, channel_id, kind, requires_presence)
        VALUES (${`land_${guildId}`}, ${guildId}, ${landCat.id}, 'land', false)
        ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, requires_presence = EXCLUDED.requires_presence
      `;

      log.info(
        {
          guild: guild.name,
          bazaar: `${bazaar.id}${createdText ? " (created)" : " (found)"}`,
          voice: seededVoice.join(", "),
          land: `${landCat.id}${createdCat ? " (created)" : " (found)"}`,
        },
        "bazaar mapped",
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
    let bpSeeded = 0;
    for (const bp of blueprints) {
      const rows = await opts.sql`
        INSERT INTO blueprint_catalog (id, name, cost_gold, base_ms)
        VALUES (${bp.id}, ${bp.name}, ${bp.costGold}, ${bp.baseMs})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      bpSeeded += rows.length;
    }
    log.info({ seeded: bpSeeded, total: blueprints.length }, "blueprint catalog seeded (existing rows untouched)");

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
