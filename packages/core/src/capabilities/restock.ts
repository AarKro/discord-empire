/**
 * restock (framework spec §2.5 local trade goods, §3 `stock.restocked`) — shelves
 * recover on their own.
 *
 * Before this, `world-init` seeded stock once and said so twice ("never
 * restocks"): a busy continent stripped its shelves permanently and the only cure
 * was `world:init --force`. The sharper edge was on the permit tokens, seeded at a
 * flat 1,000,000 with no replenish path — had one ever hit zero, `executeTrade`'s
 * stock guard would have failed every build, research and muster in the realm with
 * "sorry, just sold out!".
 *
 * WHY THIS RIDES tick.minute RATHER THAN tick.hour, which would read better:
 * the permit sinks must be checked every minute (an empty one refuses that
 * action realm-wide), and an hourly prompt would still lose up to an hour of
 * accrual to every tick-service restart. So the clock is elapsed wall-time held
 * in `npcs.state` (the same per-guild jsonb map the stall's pinned message id
 * uses), and the minute tick is only a prompt to go and look. That also makes
 * catch-up after downtime automatic: `restockAmount` accrues the missed
 * intervals and clamps to the cap.
 *
 * The policy itself lives in `world/goods.ts` and is pure. This capability only
 * decides WHEN to ask and performs the write, and it writes nothing at all when
 * nothing is short — an idle world produces no ledger rows.
 */
import type { Continents, Shop } from "@empire/content-schemas";
import type { Capability, CapabilityContext } from "../runtime/capability.js";
import type { BusEvent } from "../events/bus.js";
import { npcAt } from "../world/npc-identity.js";
import { regionOf, regionalItem, restockAmount } from "../world/goods.js";
import { readNpcState, upsertNpcStateEntry } from "../world/npc-state.js";
import { restockShop, type Sql } from "@empire/db";

/** How much wall-clock one unit of a ware's `restock` rate buys. */
export const RESTOCK_INTERVAL_MS = Number(process.env.RESTOCK_INTERVAL_MS ?? 60 * 60_000);

/** The `npcs.state` map holding the last restock time per continent. */
const STATE_MAP = "restocked_at";

/** Bots with no shop still hold tokens that must never run dry (§5.12 permits). */
export interface RestockConfig {
  unlimitedItems?: string[];
}

export function restockCapability(config: RestockConfig, shop?: Shop, continents?: Continents): Capability {
  /** Live stock for one owner, keyed by item. */
  async function heldBy(sql: Sql, ownerId: string): Promise<Map<string, number>> {
    const rows = await sql<{ item_id: string; qty: number }[]>`
      SELECT item_id, qty FROM inventories WHERE owner_kind = 'npc' AND owner_id = ${ownerId}
    `;
    return new Map(rows.map((r) => [r.item_id, r.qty]));
  }

  /**
   * Whole intervals elapsed for `key`, and null when it isn't due yet. A key with
   * no recorded time is stamped and treated as not due, so a fresh world doesn't
   * hand out a windfall on the first tick from an epoch-zero baseline.
   */
  async function intervalsDue(ctx: CapabilityContext, key: string): Promise<number | null> {
    const state = await readNpcState<Record<string, Record<string, string> | undefined>>(ctx.sql, ctx.bot);
    const last = state[STATE_MAP]?.[key];
    const now = Date.now();
    if (!last) {
      await upsertNpcStateEntry(ctx.sql, ctx.bot, STATE_MAP, key, new Date(now).toISOString());
      return null;
    }
    const elapsed = now - new Date(last).getTime();
    const intervals = Math.floor(elapsed / RESTOCK_INTERVAL_MS);
    if (intervals < 1) return null;
    // Advance by the WHOLE intervals consumed, not to `now`, so a remainder isn't
    // discarded and the rate stays honest over a long run.
    const consumed = new Date(new Date(last).getTime() + intervals * RESTOCK_INTERVAL_MS).toISOString();
    await upsertNpcStateEntry(ctx.sql, ctx.bot, STATE_MAP, key, consumed);
    return intervals;
  }

  /** Top up one continent's shelf; returns how many wares actually moved. */
  async function restockShelf(ctx: CapabilityContext, guildId: string, intervals: number): Promise<number> {
    if (!shop || !continents) return 0;
    const ownerId = npcAt(ctx.bot, guildId);
    const held = await heldBy(ctx.sql, ownerId);
    const region = regionOf(continents, guildId);
    let moved = 0;
    for (const item of shop.items) {
      const cap = regionalItem(item, region).stock;
      const currentQty = held.get(item.item_id) ?? 0;
      const qty = restockAmount(item, { currentQty, cap, intervals });
      if (qty <= 0) continue;
      await restockShop(ctx.sql, { npcId: ownerId, itemId: item.item_id, qty });
      moved += 1;
    }
    return moved;
  }

  /**
   * Keep the never-empty tokens topped. These hang off the BARE bot id: a permit
   * sink is a cost sink, not geography, so unlike shop stock it does not fork per
   * continent.
   */
  async function restockTokens(ctx: CapabilityContext): Promise<number> {
    const items = config.unlimitedItems ?? [];
    if (items.length === 0) return 0;
    const held = await heldBy(ctx.sql, ctx.bot);
    let moved = 0;
    for (const itemId of items) {
      const currentQty = held.get(itemId) ?? 0;
      const qty = restockAmount({ item_id: itemId, name: itemId, base_price: 0, stock: 0, unlimited: true }, {
        currentQty,
        cap: 0,
        intervals: 1,
      });
      if (qty <= 0) continue;
      await restockShop(ctx.sql, { npcId: ctx.bot, itemId, qty });
      moved += 1;
    }
    return moved;
  }

  return {
    name: "restock",
    consumes: ["tick.minute"],
    // Nothing to expose to workflows: restocking is the world's own bookkeeping,
    // never something an author composes into a state machine.
    actions: {},

    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      if (evt.type !== "tick.minute") return;

      // Tokens are checked every tick and cost one read: they must never be
      // waiting on an interval, since an empty permit sink breaks the realm.
      await restockTokens(ctx);

      if (!shop || !continents) return;
      for (const guildId of ctx.personas.guildIds) {
        const intervals = await intervalsDue(ctx, guildId);
        if (intervals === null) continue;
        const moved = await restockShelf(ctx, guildId, intervals);
        if (moved === 0) continue;
        ctx.logger.info({ guildId, intervals, wares: moved }, "shop restocked");
        // §3's event name. The stall listens for it: without this the pinned
        // embed would keep advertising the pre-restock shelf until the next sale.
        await ctx.bus.publish({
          type: "shop.restocked",
          guildId,
          subject: { kind: "npc", id: ctx.bot },
          payload: { wares: moved },
        });
      }
    },
  };
}
