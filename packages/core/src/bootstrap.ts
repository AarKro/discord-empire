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

export interface BootstrapOptions {
  token: string;
  sql: Sql;
  continents: Continents;
  /** The NPC whose stall/stock is being seeded (iteration 1: "merchant"). */
  npcId: string;
  shop: Shop;
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

      let bazaarVc = channels.find((c) => c?.type === ChannelType.GuildVoice && c.name === "Bazaar") ?? null;
      let createdVoice = false;
      if (!bazaarVc) {
        bazaarVc = await guild.channels.create({ name: "Bazaar", type: ChannelType.GuildVoice });
        createdVoice = true;
      }

      // Iteration 1 has no travel yet, so the bazaar must not gate on position.
      await opts.sql`
        INSERT INTO locations (id, guild_id, channel_id, kind, requires_presence)
        VALUES (${`bazaar_${guildId}`}, ${guildId}, ${bazaar.id}, 'bazaar', false)
        ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, requires_presence = EXCLUDED.requires_presence
      `;

      log.info(
        {
          guild: guild.name,
          bazaar: `${bazaar.id}${createdText ? " (created)" : " (found)"}`,
          voice: `${bazaarVc.id}${createdVoice ? " (created)" : " (found)"}`,
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
  } finally {
    await client.destroy();
  }
}
