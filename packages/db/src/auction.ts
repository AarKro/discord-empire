/**
 * Auction close settlement (framework spec §5.11).
 *
 * An auction escrows two things while it runs (both via `executeTrade`, so gold
 * only ever moves through a vetted atomic writer — invariant #2):
 *   - the LISTED ITEM, held under the auction Party `auction:<offer_id>` from
 *     listing time (a price-0 trade), so it can't be sold elsewhere; and
 *   - the WINNING BID's gold, deposited into the same auction Party's balance
 *     when the current-high bid is placed (outbid bids are refunded live).
 *
 * `settleAuction` is the atomic CLOSE: one transaction that claims the auction
 * exactly once, then either delivers item→winner + gold→lister (WON) or returns
 * the item→lister (UNSOLD). The claim (`UPDATE ... WHERE status='open'`) makes it
 * idempotent against tick-service re-firing `auction.closed` every tick while the
 * row is still open (apps/tick-service/src/main.ts).
 *
 * Reconciliation: settlement moves value between THREE parties (auction hub →
 * winner for the item, auction hub → lister for the gold), so it writes two
 * ledger rows, each a clean two-party transfer against the `auction` hub. The
 * winner's gold already left their balance at bid time; it is NOT re-debited here.
 */
import type { Sql } from "./client.js";
import { jsonParam } from "./client.js";

export interface SettleAuctionRequest {
  /** The auction's offers.id (also the auction Party id: `auction:<offerId>` escrow owner). */
  offerId: string;
  /** Public event id for the resulting trade.completed event (WON only). Must be unique. */
  eventId: string;
  correlationId?: string | null | undefined;
}

export type SettleAuctionResult =
  | { ok: true; outcome: "won" | "unsold"; ledgerId: string; eventDbId?: string }
  | { ok: false; reason: "already_settled" };

export async function settleAuction(sql: Sql, req: SettleAuctionRequest): Promise<SettleAuctionResult> {
  return sql.begin(async (tx) => {
    // Claim the close exactly once. The conditional UPDATE both settles the
    // status AND tells us won-vs-unsold via the returned taker_id (the current
    // high bidder; NULL ⟺ no qualifying bid ⟺ no escrowed gold). A second
    // (re-fired) call finds status != 'open' and no-ops.
    const claimed = await tx<
      { item_id: string; qty: number; maker_id: string; price: number; taker_id: string | null; guild_id: string | null }[]
    >`
      UPDATE offers
         SET status = CASE WHEN taker_id IS NOT NULL THEN 'filled' ELSE 'expired' END
       WHERE id = ${req.offerId} AND kind = 'auction' AND status = 'open'
      RETURNING item_id, qty, maker_id, price, taker_id, guild_id
    `;
    if (claimed.length === 0) return { ok: false, reason: "already_settled" } as const;
    const a = claimed[0]!;
    const auction = req.offerId; // owner_id of the `auction`-kind escrow rows

    if (a.taker_id) {
      // WON — deliver escrowed item to the winner, pay escrowed gold to the lister.
      const item = await tx`
        UPDATE inventories SET qty = qty - ${a.qty}
         WHERE owner_kind = 'auction' AND owner_id = ${auction} AND item_id = ${a.item_id} AND qty >= ${a.qty}
        RETURNING qty
      `;
      if (item.length === 0) throw new Error(`settleAuction: escrowed item missing for ${req.offerId}`);
      await tx`
        INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
        VALUES ('player', ${a.taker_id}, ${a.item_id}, ${a.qty})
        ON CONFLICT (owner_kind, owner_id, item_id) DO UPDATE SET qty = inventories.qty + ${a.qty}
      `;
      const gold = await tx`
        UPDATE balances SET amount = amount - ${a.price}
         WHERE owner_kind = 'auction' AND owner_id = ${auction} AND currency = 'gold' AND amount >= ${a.price}
        RETURNING amount
      `;
      if (gold.length === 0) throw new Error(`settleAuction: escrowed gold missing for ${req.offerId}`);
      await tx`
        INSERT INTO balances (owner_kind, owner_id, currency, amount)
        VALUES ('player', ${a.maker_id}, 'gold', ${a.price})
        ON CONFLICT (owner_kind, owner_id, currency) DO UPDATE SET amount = balances.amount + ${a.price}
      `;
      await tx`UPDATE bids SET status = 'won' WHERE offer_id = ${req.offerId} AND bidder_id = ${a.taker_id} AND status = 'held'`;

      // The sale event (winner bought from lister) + transactional NOTIFY.
      const evt = await tx`
        INSERT INTO events (event_id, type, guild_id, actor_kind, actor_id, subject_kind, subject_id, payload, correlation_id)
        VALUES (
          ${req.eventId}, 'trade.completed', ${a.guild_id ?? null},
          'player', ${a.taker_id}, 'player', ${a.maker_id},
          ${jsonParam(sql, { item: a.item_id, qty: a.qty, price: a.price, currency: "gold", auction: req.offerId })},
          ${req.correlationId ?? null}
        )
        RETURNING id
      `;
      const eventDbId = String(evt[0]!.id);
      // Two reconciling rows against the auction hub: item → winner, gold → lister.
      await tx`
        INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason, cause_event_id)
        VALUES ('player', ${a.taker_id}, 'auction', ${auction}, 'gold', 0, ${jsonParam(sql, { [a.item_id]: a.qty })}, 'auction_won', ${eventDbId})
      `;
      const led = await tx`
        INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason, cause_event_id)
        VALUES ('player', ${a.maker_id}, 'auction', ${auction}, 'gold', ${a.price}, ${jsonParam(sql, {})}, 'auction_payout', ${eventDbId})
        RETURNING id
      `;
      await tx`SELECT pg_notify('empire_events', ${eventDbId})`;
      return { ok: true, outcome: "won", ledgerId: String(led[0]!.id), eventDbId } as const;
    }

    // UNSOLD — no qualifying bid; return the escrowed item to the lister.
    const item = await tx`
      UPDATE inventories SET qty = qty - ${a.qty}
       WHERE owner_kind = 'auction' AND owner_id = ${auction} AND item_id = ${a.item_id} AND qty >= ${a.qty}
      RETURNING qty
    `;
    if (item.length === 0) throw new Error(`settleAuction: escrowed item missing for ${req.offerId}`);
    await tx`
      INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
      VALUES ('player', ${a.maker_id}, ${a.item_id}, ${a.qty})
      ON CONFLICT (owner_kind, owner_id, item_id) DO UPDATE SET qty = inventories.qty + ${a.qty}
    `;
    const led = await tx`
      INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason)
      VALUES ('player', ${a.maker_id}, 'auction', ${auction}, 'gold', 0, ${jsonParam(sql, { [a.item_id]: a.qty })}, 'auction_expired')
      RETURNING id
    `;
    return { ok: true, outcome: "unsold", ledgerId: String(led[0]!.id) } as const;
  });
}
