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
 *
 * Rewards (world → player) mirror that pair: the `grant.give` ACTION for
 * workflow-authored rewards, and the `grant.requested` EVENT for rewards a
 * capability computes at runtime and therefore cannot spell out in YAML — a
 * combat loot roll being the first (§5.13). Both land on the same grantReward
 * writer, which is what keeps "only trade writes the ledger" literally true.
 */
import { executeTrade, grantReward, type Party } from "@empire/db";
import type { Shop, ShopItem } from "@empire/content-schemas";
import type { Capability, CapabilityContext } from "../runtime/capability.js";
import type { BusEvent } from "../events/bus.js";
import { notForMe } from "../events/helpers.js";
import { ulid } from "ulid";

export interface QuoteInput {
  buyer: Party;
  seller: Party;
  itemId: string;
  qty: number;
  price: number;
  guildId?: string | null | undefined;
  correlationId?: string | null | undefined;
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

async function runQuote(quote: QuoteInput, ctx: CapabilityContext): Promise<void> {
  const result = await executeTrade(ctx.sql, {
    eventId: `evt_${ulid()}`,
    buyer: quote.buyer,
    seller: quote.seller,
    itemId: quote.itemId,
    qty: quote.qty,
    price: quote.price,
    guildId: quote.guildId,
    correlationId: quote.correlationId,
  });
  if (!result.ok) {
    // executeTrade only emits trade.completed on success; emit the failure
    // here so consumers (notify, stall refresh) can react.
    await publishFailure(ctx, quote, result.reason, result.message);
    ctx.logger.info({ reason: result.reason, item: quote.itemId }, "trade rejected");
  }
}

async function publishFailure(
  ctx: CapabilityContext,
  quote: QuoteInput,
  reason: string,
  message: string,
): Promise<void> {
  await ctx.bus.publish({
    type: "trade.failed",
    guildId: quote.guildId,
    actor: { kind: quote.buyer.kind, id: quote.buyer.id },
    subject: { kind: quote.seller.kind, id: quote.seller.id },
    payload: { item: quote.itemId, qty: quote.qty, reason, message },
    correlationId: quote.correlationId,
  });
}

/** What a reward hands over — the shared shape of `grant.give` and `grant.requested`. */
export interface RewardSpec {
  gold?: number;
  item?: string;
  qty?: number;
  reputation?: number;
}

/**
 * Hand a player a reward (gold / item / reputation), ledger-safe via grantReward
 * (world → player). Shared by the `grant.give` action and the `grant.requested`
 * event so both paths ledger and announce identically. Reputation is scored
 * against this bot's NPC.
 */
async function giveReward(
  ctx: CapabilityContext,
  player: string,
  spec: RewardSpec,
  evt: BusEvent | null | undefined,
): Promise<void> {
  await grantReward(ctx.sql, { player, npc: ctx.bot, ...spec });
  ctx.logger.info({ player, ...spec }, "reward granted");
  await ctx.bus.publish({
    type: "reward.granted",
    guildId: evt?.guildId ?? null,
    actor: { kind: "player", id: player },
    subject: { kind: "npc", id: ctx.bot },
    payload: { ...spec },
    correlationId: evt?.correlationId ?? null,
  });
}

export function tradeCapability(shop?: Shop): Capability {
  return {
    name: "trade",
    // trade.request is the dialogue-emitted purchase intent (§5.4 → §5.5);
    // grant.requested is a runtime-computed reward (§5.13 loot).
    consumes: ["trade.request", "grant.requested"],
    actions: {
      /**
       * `trade.execute` — the verb workflows and commands call. Never mutates
       * the economy itself beyond the atomic ledger contract; races resolve at
       * the ledger (§7 concurrency rule).
       */
      "trade.execute": async (args, _evt, ctx: CapabilityContext) => {
        await runQuote(args as unknown as QuoteInput, ctx);
      },

      /**
       * `grant.give` — hand the player a reward (gold / item / reputation) from a
       * workflow (§7 quest/dialogue rewards). Ledger-safe via grantReward (world →
       * player), keeping the "ledger only through trade" invariant. The player is
       * the acting event's actor; reputation is scored against this NPC.
       */
      "grant.give": async (args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        // Spread only the keys the workflow actually set (no explicit undefineds).
        await giveReward(ctx, player, args as RewardSpec, evt);
      },
    },

    /** Consume `trade.request` events emitted by dialogue options. */
    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      // A runtime-computed reward (§5.13 loot rolls): the requesting capability
      // knows WHAT to give but must not write the ledger itself, so it addresses
      // this event to its own bot and `trade` performs the grant.
      if (evt.type === "grant.requested") {
        if (notForMe(evt, ctx.bot)) return;
        const player = evt.actor?.id;
        if (!player) {
          ctx.logger.warn({ evt: evt.eventId }, "malformed grant.requested ignored");
          return;
        }
        await giveReward(ctx, player, evt.payload as RewardSpec, evt);
        return;
      }
      if (evt.type !== "trade.request") return;
      // The bus is broadcast: every bot's trade capability sees this event.
      // Only the addressed NPC executes, or the trade would run once per bot.
      if (notForMe(evt, ctx.bot)) return;
      const payload = evt.payload as { item?: string; qty?: number; price?: number };
      const buyer = evt.actor;
      if (!buyer || !payload.item || typeof payload.price !== "number") {
        ctx.logger.warn({ evt: evt.eventId }, "malformed trade.request ignored");
        return;
      }
      const seller: Party = { kind: "npc", id: evt.subject?.id ?? ctx.bot };
      const quote: QuoteInput = {
        buyer: { kind: buyer.kind as Party["kind"], id: buyer.id },
        seller,
        itemId: payload.item,
        qty: payload.qty ?? 1,
        price: payload.price,
        guildId: evt.guildId,
        correlationId: evt.correlationId,
      };

      // Enforce the hidden reputation-adjusted floor for shop-backed items.
      const item = shop?.items.find((candidate) => candidate.item_id === quote.itemId);
      if (item) {
        const [reputationRow] = await ctx.sql<{ score: number }[]>`
          SELECT score FROM reputation WHERE player_id = ${quote.buyer.id} AND npc_id = ${seller.id}
        `;
        const floor = effectiveFloor(item, reputationRow?.score ?? 0);
        // quote.price is the TOTAL offer (db contract); floor is per unit.
        if (quote.price < floor * quote.qty) {
          await publishFailure(ctx, quote, "lowball", "I can't part with it for that, friend.");
          ctx.logger.info({ item: quote.itemId, offered: quote.price, floor }, "offer below hidden floor");
          return;
        }
      }

      await runQuote(quote, ctx);
    },
  };
}
