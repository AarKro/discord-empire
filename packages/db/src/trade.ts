/**
 * The atomic trade contract (framework spec §5.5, §8).
 *
 * A trade is ONE Postgres transaction with conditional updates:
 *   - seller must actually hold the stock  (WHERE qty >= :qty)
 *   - buyer must actually hold the funds   (WHERE amount >= :price)
 * If any condition fails, the whole transaction rolls back and the caller
 * gets a structured `trade.failed` result with an in-fiction reason.
 *
 * "The database is the referee": no NPC or player is locked. Two buyers may
 * race for the last item and both haggle freely — the ledger decides, and
 * exactly one wins.
 *
 * Transactional emit (§3): the event row + NOTIFY fire inside the SAME
 * transaction as the ledger write, so an announced trade is a committed trade.
 *
 * Hand-written SQL is used here deliberately (tech spec permits/expects it for
 * the ledger's conditional atomic updates); Drizzle owns the schema, not this.
 */
import type { Sql } from "./client.js";
import { jsonParam } from "./client.js";

export interface Party {
  kind: "player" | "npc" | "market" | "auction" | "world";
  id: string;
}

export interface TradeRequest {
  /** Public event id for the resulting trade.completed / trade.failed event. */
  eventId: string;
  /** Nullable so callers can forward `evt.correlationId`/`evt.guildId` directly; coalesced to NULL below. */
  correlationId?: string | null | undefined;
  guildId?: string | null | undefined;
  /** The one paying currency and receiving the item. */
  buyer: Party;
  /** The one receiving currency and giving the item. */
  seller: Party;
  itemId: string;
  qty: number;
  /** Total price in currency units (not per-unit). */
  price: number;
  currency?: string;
  reason?: string;
}

export type TradeResult =
  | { ok: true; ledgerId: string; eventDbId: string; eventId: string }
  | { ok: false; reason: "out_of_stock" | "insufficient_funds" | "invalid_request"; message: string };

function validate(req: TradeRequest): string | null {
  if (!Number.isFinite(req.qty) || req.qty <= 0) return "quantity must be positive";
  if (!Number.isFinite(req.price) || req.price < 0) return "price must be non-negative";
  if (!req.itemId) return "item is required";
  if (req.buyer.kind === req.seller.kind && req.buyer.id === req.seller.id)
    return "buyer and seller must differ";
  return null;
}

/**
 * Execute an atomic conditional trade. Never throws on business-rule failure;
 * throws only on real infrastructure errors.
 */
export async function executeTrade(sql: Sql, req: TradeRequest): Promise<TradeResult> {
  const invalid = validate(req);
  if (invalid) return { ok: false, reason: "invalid_request", message: invalid };

  const currency = req.currency ?? "gold";
  const reason = req.reason ?? "npc_trade";

  try {
    return await sql.begin(async (tx) => {
      // 1) Conditionally remove stock from the seller. Row must exist AND hold
      //    enough. UPDATE ... WHERE qty >= :qty is the atomic guard: with
      //    row-level locking, exactly one of two racing buyers can satisfy it
      //    for the last unit.
      const stock = await tx`
        UPDATE inventories
           SET qty = qty - ${req.qty}
         WHERE owner_kind = ${req.seller.kind}
           AND owner_id   = ${req.seller.id}
           AND item_id    = ${req.itemId}
           AND qty       >= ${req.qty}
        RETURNING qty
      `;
      if (stock.length === 0) {
        // Roll back by throwing a sentinel; caught below.
        throw new TradeFail("out_of_stock", "sorry, just sold out!");
      }

      // 2) Conditionally debit the buyer's balance.
      const bal = await tx`
        UPDATE balances
           SET amount = amount - ${req.price}
         WHERE owner_kind = ${req.buyer.kind}
           AND owner_id   = ${req.buyer.id}
           AND currency   = ${currency}
           AND amount    >= ${req.price}
        RETURNING amount
      `;
      if (bal.length === 0) {
        throw new TradeFail("insufficient_funds", "you don't have the coin for that");
      }

      // 3) Credit the seller's currency (upsert; sellers may be NPCs with no row yet).
      await tx`
        INSERT INTO balances (owner_kind, owner_id, currency, amount)
        VALUES (${req.seller.kind}, ${req.seller.id}, ${currency}, ${req.price})
        ON CONFLICT (owner_kind, owner_id, currency)
        DO UPDATE SET amount = balances.amount + ${req.price}
      `;

      // 4) Credit the buyer's inventory (upsert).
      await tx`
        INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
        VALUES (${req.buyer.kind}, ${req.buyer.id}, ${req.itemId}, ${req.qty})
        ON CONFLICT (owner_kind, owner_id, item_id)
        DO UPDATE SET qty = inventories.qty + ${req.qty}
      `;

      // 5) Append the trade.completed event (the replay/announce source).
      const evt = await tx`
        INSERT INTO events (event_id, type, guild_id, actor_kind, actor_id, subject_kind, subject_id, payload, correlation_id)
        VALUES (
          ${req.eventId}, 'trade.completed', ${req.guildId ?? null},
          ${req.buyer.kind}, ${req.buyer.id}, ${req.seller.kind}, ${req.seller.id},
          ${jsonParam(sql, { item: req.itemId, qty: req.qty, price: req.price, currency })},
          ${req.correlationId ?? null}
        )
        RETURNING id
      `;
      const eventDbId = String(evt[0]!.id);

      // 6) Append the append-only ledger row, referencing the cause event.
      //    itemDeltas are recorded from the buyer's perspective.
      const led = await tx`
        INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason, cause_event_id)
        VALUES (
          ${req.buyer.kind}, ${req.buyer.id}, ${req.seller.kind}, ${req.seller.id},
          ${currency}, ${-req.price}, ${jsonParam(sql, { [req.itemId]: req.qty })},
          ${reason}, ${eventDbId}
        )
        RETURNING id
      `;
      const ledgerId = String(led[0]!.id);

      // 7) Transactional emit: NOTIFY inside the same tx. Payload carries only
      //    the event id (consumers read the full row) to sidestep the 8KB cap.
      await tx`SELECT pg_notify('empire_events', ${eventDbId})`;

      return { ok: true, ledgerId, eventDbId, eventId: req.eventId } as const;
    });
  } catch (err) {
    if (err instanceof TradeFail) {
      return { ok: false, reason: err.reason, message: err.message };
    }
    throw err;
  }
}

class TradeFail extends Error {
  constructor(
    public readonly reason: "out_of_stock" | "insufficient_funds",
    message: string,
  ) {
    super(message);
    this.name = "TradeFail";
  }
}
