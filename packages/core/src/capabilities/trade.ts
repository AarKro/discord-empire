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
import { collectProduction, craftItem, executeTrade, grantReward, sellToWorld, type Party, type Sql } from "@empire/db";
import { accrued, msToNextUnit } from "../world/production.js";
import { replyToCommand } from "../events/reply.js";
import type { Continents, GearCatalog, Shop, ShopItem } from "@empire/content-schemas";
import type { Capability, CapabilityContext } from "../runtime/capability.js";
import type { BusEvent } from "../events/bus.js";
import { notForMe } from "../events/helpers.js";
import { npcAt } from "../world/npc-identity.js";
import { buybackPrice, regionOf, regionalItem } from "../world/goods.js";
import { payloadString } from "../events/helpers.js";
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

/** "iron_tools" → "iron tools": item ids read as prose in player-facing lines. */
function itemLabel(itemId: string): string {
  return itemId.replace(/_/g, " ");
}

/**
 * /collect (§2.4): bank everything the player's buildings have accrued, as one
 * ledgered write, and say what came in — or, when the stores are bare, how long
 * until the next unit. Lives HERE, and is only ever called from this
 * capability's `collect.requested` handler, because it writes the ledger — and
 * only `trade` does that (invariant #2).
 */
export async function collectProductionFor(sql: Sql, playerId: string): Promise<string> {
  const { now, gathered, buildings } = await collectProduction(sql, playerId, accrued);
  if (buildings.length === 0) return "Nothing on your land produces yet — a farm or a forge would.";
  const got = Object.entries(gathered);
  const soonest = buildings
    .map((b) => ({ item: b.produces.item, ms: msToNextUnit(b.produces, b.since, now) }))
    .sort((x, y) => x.ms - y.ms)[0]!;
  const next = `next ${itemLabel(soonest.item)} in ~${Math.max(1, Math.ceil(soonest.ms / 60_000))}m`;
  if (got.length === 0) return `Your stores are bare — ${next}.`;
  const lines = got.map(([item, qty]) => `**${qty}× ${itemLabel(item)}**`).join(", ");
  return `You gather ${lines}. Sell them at a merchant's stall — ${next}.`;
}

/**
 * /craft (§2.6 champion gear): turn goods and gold into one piece of gear at the
 * player's own FINISHED forge. Priced from the gear catalog, never the command's
 * options; settled atomically by craftItem (any shortfall changes nothing) and
 * answered on the command's correlation.
 */
async function craftGear(evt: BusEvent, ctx: CapabilityContext, catalog: GearCatalog): Promise<void> {
  const player = evt.actor?.id;
  if (!player) return;
  const say = (message: string) => replyToCommand(ctx, evt, player, message);
  const gear = catalog.gear.find((g) => g.item_id === payloadString(evt, "gear"));
  if (!gear) {
    await say("I don't know how to make that.");
    return;
  }
  const [forge] = await ctx.sql<{ one: number }[]>`
    SELECT 1 AS one FROM build_queue
    WHERE owner_id = ${player} AND blueprint_id = ${gear.recipe.requires} AND status = 'completed' LIMIT 1
  `;
  if (!forge) {
    await say(`That's ${gear.recipe.requires.replace(/_/g, " ")} work — you'll need one standing on your land first.`);
    return;
  }
  const result = await craftItem(ctx.sql, { player, inputs: gear.recipe.goods, gold: gear.recipe.gold, output: gear.item_id });
  if (!result.ok) {
    await say(
      result.reason === "insufficient_funds"
        ? `The smithing costs ${gear.recipe.gold} gold, and your purse is lighter than that.`
        : `You're short of ${itemLabel(result.item)} — it takes ${gear.recipe.goods[result.item]}.`,
    );
    return;
  }
  ctx.logger.info({ player, gear: gear.item_id }, "gear crafted");
  await say(`The forge rings. You've made **${gear.name}** — \`/equip\` it to take it into battle.`);
}

/**
 * A player selling goods to this merchant (§2.5 buy-back), from the stall's
 * sell menu. Priced HERE — at this continent's regional price times the spread —
 * never from the event, so a forged or stale payload can't name its own price.
 * `qty: "all"` sells whatever the player holds at the moment of the click.
 */
async function sellGoods(evt: BusEvent, ctx: CapabilityContext, shop: Shop, continents: Continents): Promise<void> {
  const player = evt.actor?.id;
  const itemId = payloadString(evt, "item");
  if (!player || !itemId) {
    ctx.logger.warn({ evt: evt.eventId }, "malformed sell.request ignored");
    return;
  }
  const fail = async (message: string): Promise<void> => {
    await ctx.bus.publish({
      type: "sale.failed",
      guildId: evt.guildId,
      actor: { kind: "player", id: player },
      subject: { kind: "npc", id: ctx.bot },
      payload: { item: itemId, message },
      correlationId: evt.correlationId,
    });
  };
  const good = shop.buys.find((b) => b.item_id === itemId);
  if (!good) {
    await fail("I've no use for that, friend.");
    return;
  }
  let qty: number;
  const rawQty = (evt.payload as { qty?: unknown } | undefined)?.qty;
  if (rawQty === "all") {
    const [held] = await ctx.sql<{ qty: number }[]>`
      SELECT qty FROM inventories WHERE owner_kind = 'player' AND owner_id = ${player} AND item_id = ${itemId}
    `;
    qty = held?.qty ?? 0;
  } else {
    qty = Number(rawQty);
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    await fail("You've none of that left to sell.");
    return;
  }
  const unit = buybackPrice(good, regionOf(continents, evt.guildId));
  const gold = unit * qty;
  const result = await sellToWorld(ctx.sql, { player, itemId, qty, gold });
  if (!result.ok) {
    await fail("You've not got that many to sell.");
    return;
  }
  ctx.logger.info({ player, item: itemId, qty, gold }, "goods sold to merchant");
  await ctx.bus.publish({
    type: "sale.completed",
    guildId: evt.guildId,
    actor: { kind: "player", id: player },
    subject: { kind: "npc", id: ctx.bot },
    payload: { item: itemId, name: good.name, qty, gold },
    correlationId: evt.correlationId,
  });
}

/** A shop item restated at one continent's prices, for `effectiveFloor` (§2.5). */
function regionallyPriced(item: ShopItem, region: string | null): ShopItem {
  const regional = regionalItem(item, region);
  return { ...item, base_price: regional.price, floor_price: regional.floorPrice };
}

/**
 * `continents` is required whenever `shop` is given: a shop's prices are regional
 * (§2.5), and without the ring every ware would read as imported and be charged
 * at the premium. Bots that carry `trade` purely as a cost sink (the Builder's
 * permits, the Warden's loot grants) pass neither.
 */
export function tradeCapability(shop?: Shop, continents?: Continents, gear?: GearCatalog): Capability {
  return {
    name: "trade",
    // trade.request is the dialogue-emitted purchase intent (§5.4 → §5.5);
    // grant.requested is a runtime-computed reward (§5.13 loot); sell.request
    // is a player selling goods back from the stall's sell menu (§2.5).
    // collect.requested is /collect banking building production (§2.4).
    // craft.requested is /craft making champion gear (§2.6).
    consumes: ["trade.request", "grant.requested", "sell.request", "collect.requested", "craft.requested"],
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
      if (evt.type === "craft.requested") {
        if (notForMe(evt, ctx.bot)) return;
        if (!gear) return;
        await craftGear(evt, ctx, gear);
        return;
      }
      if (evt.type === "collect.requested") {
        if (notForMe(evt, ctx.bot)) return;
        const player = evt.actor?.id;
        if (!player) return;
        await replyToCommand(ctx, evt, player, await collectProductionFor(ctx.sql, player));
        return;
      }
      if (evt.type === "sell.request") {
        if (notForMe(evt, ctx.bot)) return;
        // Only a shop-backed merchant buys; a cost-sink bot has nothing to price with.
        if (!shop || !continents) return;
        await sellGoods(evt, ctx, shop, continents);
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
      // The seller is this bot's persona ON THIS CONTINENT (§2.5). One party
      // carries three things — whose stock is decremented, who stands as the
      // ledger counterparty, and whose reputation is read — so qualifying it by
      // guild is what makes Aldric and Mei Lin genuinely different traders,
      // with separate purses and separate standing.
      // `notForMe` above already guarantees the subject IS this bot, so the
      // regional id is derived rather than read off the event — the event only
      // ever carries the bare bot id.
      const shopGuildId = evt.guildId ?? ctx.personas.homeGuild(null);
      const seller: Party = { kind: "npc", id: npcAt(ctx.bot, shopGuildId) };
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
        // Haggle against THIS continent's price (§2.5). Passing the raw item
        // would let a player talk an import down to its home floor, quietly
        // undoing the premium and making the curio the cheap way to buy it.
        //
        // With no ring configured, fall back to the raw item rather than to
        // `regionOf`'s null — a null region reads as "nothing is local", which
        // would charge every ware the import premium. The factory makes this
        // unreachable; the fallback just picks the harmless direction.
        const priced = continents ? regionallyPriced(item, regionOf(continents, shopGuildId)) : item;
        const floor = effectiveFloor(priced, reputationRow?.score ?? 0);
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
