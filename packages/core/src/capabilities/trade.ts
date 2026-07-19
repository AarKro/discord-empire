/**
 * trade (framework spec §5.5) — the ONLY capability allowed to write the ledger.
 *
 * Delegates the atomic conditional transaction to @empire/db's executeTrade
 * (hand-written SQL, single transaction, transactional NOTIFY emit). Offers are
 * quotes with expiry, never reservations: confirmation re-validates atomically
 * and failures return in-fiction reasons (§5.5).
 *
 * Two entry points, one contract:
 *   - the `trade.execute` ACTION (workflows/commands call it with an explicit
 *     buyer/seller quote — e.g. Builder's blueprint cost deduction), and
 *   - the `trade.request` EVENT (emitted by dialogue options — e.g. Aldric's
 *     haggle tree). For shop-backed requests the hidden, reputation-adjusted
 *     floor (§5.4) is enforced HERE, not in the dialogue data: the tree only
 *     shapes which offers a player can make; the trade capability decides
 *     which offers the NPC accepts.
 */
import { executeTrade, type Party } from "@empire/db";
import type { Shop, ShopItem } from "@empire/content-schemas";
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";
import { ulid } from "ulid";

export interface QuoteInput {
  buyer: Party;
  seller: Party;
  itemId: string;
  qty: number;
  price: number;
  guildId?: string;
  correlationId?: string;
}

/**
 * The hidden floor for a shop item, adjusted by the buyer's reputation with
 * this NPC (§5.4 "haggling against a hidden floor").
 *
 * - No `floor_price` on the item → the price is firm: floor = base_price.
 * - With `floor_price`: each point of reputation discounts the base price by
 *   `reputation_discount` (e.g. 0.15/point), but never below `floor_price`.
 *   A stranger (rep 0) pays base; a regular's floor converges to floor_price.
 */
export function effectiveFloor(item: ShopItem, reputationScore: number): number {
  if (item.floor_price === undefined) return item.base_price;
  const rep = Math.max(0, reputationScore);
  const discount = Math.min(1, (item.reputation_discount ?? 0) * rep);
  const discounted = Math.ceil(item.base_price * (1 - discount));
  return Math.max(item.floor_price, discounted);
}

async function runQuote(q: QuoteInput, ctx: CapabilityContext): Promise<void> {
  const res = await executeTrade(ctx.sql, {
    eventId: `evt_${ulid()}`,
    buyer: q.buyer,
    seller: q.seller,
    itemId: q.itemId,
    qty: q.qty,
    price: q.price,
    ...(q.guildId !== undefined ? { guildId: q.guildId } : {}),
    ...(q.correlationId !== undefined ? { correlationId: q.correlationId } : {}),
  });
  if (!res.ok) {
    // executeTrade only emits trade.completed on success; emit the failure
    // here so consumers (voicelines, notify, stall refresh) can react.
    await publishFailure(ctx, q, res.reason, res.message);
    ctx.logger.info({ reason: res.reason, item: q.itemId }, "trade rejected");
  }
}

async function publishFailure(
  ctx: CapabilityContext,
  q: QuoteInput,
  reason: string,
  message: string,
): Promise<void> {
  await ctx.bus.publish({
    type: "trade.failed",
    ...(q.guildId !== undefined ? { guildId: q.guildId } : {}),
    actor: { kind: q.buyer.kind, id: q.buyer.id },
    subject: { kind: q.seller.kind, id: q.seller.id },
    payload: { item: q.itemId, qty: q.qty, reason, message },
    ...(q.correlationId !== undefined ? { correlationId: q.correlationId } : {}),
  });
}

export function tradeCapability(shop?: Shop): Capability {
  return {
    name: "trade",
    // trade.request is the dialogue-emitted purchase intent (§5.4 → §5.5).
    consumes: ["trade.request"],
    actions: {
      /**
       * `trade.execute` — the verb workflows and commands call. Never mutates
       * the economy itself beyond the atomic ledger contract; races resolve at
       * the ledger (§7 concurrency rule).
       */
      "trade.execute": async (args, _evt, ctx: CapabilityContext) => {
        await runQuote(args as unknown as QuoteInput, ctx);
      },
    },

    /** Consume `trade.request` events emitted by dialogue options. */
    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      if (evt.type !== "trade.request") return;
      // The bus is broadcast: every bot's trade capability sees this event.
      // Only the addressed NPC executes, or the trade would run once per bot.
      if (evt.subject && evt.subject.id !== ctx.bot) return;
      const payload = evt.payload as { item?: string; qty?: number; price?: number };
      const buyer = evt.actor;
      if (!buyer || !payload.item || typeof payload.price !== "number") {
        ctx.logger.warn({ evt: evt.eventId }, "malformed trade.request ignored");
        return;
      }
      const seller: Party = { kind: "npc", id: evt.subject?.id ?? ctx.bot };
      const q: QuoteInput = {
        buyer: { kind: buyer.kind as Party["kind"], id: buyer.id },
        seller,
        itemId: payload.item,
        qty: payload.qty ?? 1,
        price: payload.price,
        ...(evt.guildId !== null ? { guildId: evt.guildId } : {}),
        ...(evt.correlationId !== null ? { correlationId: evt.correlationId } : {}),
      };

      // Enforce the hidden reputation-adjusted floor for shop-backed items.
      const item = shop?.items.find((i) => i.item_id === q.itemId);
      if (item) {
        const [rep] = await ctx.sql<{ score: number }[]>`
          SELECT score FROM reputation WHERE player_id = ${q.buyer.id} AND npc_id = ${seller.id}
        `;
        const floor = effectiveFloor(item, rep?.score ?? 0);
        // q.price is the TOTAL offer (db contract); floor is per unit.
        if (q.price < floor * q.qty) {
          await publishFailure(ctx, q, "lowball", "I can't part with it for that, friend.");
          ctx.logger.info({ item: q.itemId, offered: q.price, floor }, "offer below hidden floor");
          return;
        }
      }

      await runQuote(q, ctx);
    },
  };
}
