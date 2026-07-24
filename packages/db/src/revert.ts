/**
 * Ledger revert (framework spec §8 "Enables audit, revert" / §9 Ops bot
 * `/admin ledger revert`). The ledger is append-only, so a revert is NOT a
 * delete — it posts the INVERSE of a transaction and undoes its effect on the
 * derived balances/inventories.
 *
 * A ledger row records deltas from the ACTOR's perspective (the counterparty
 * gets the inverse — invariant #2):
 *   actor.balance      += currency_delta        counterparty.balance += -currency_delta
 *   actor.inventory[i] += item_deltas[i]        counterparty.inventory[i] += -item_deltas[i]
 * So the revert applies the negation to the actor and its mirror to the
 * counterparty, then appends a compensating ledger row.
 *
 * God-mode (§9 admin call): the undo is UNCONDITIONAL — it will drive a balance
 * or inventory negative if the value has since been spent. It is IDEMPOTENT: the
 * compensating row's `reason='revert:<id>'` is the marker a second revert of the
 * same id detects and refuses.
 */
import type { Sql } from "./client.js";
import { jsonParam } from "./client.js";

export interface RevertLedgerRequest {
  /** The ledger.id to revert (numeric string). */
  ledgerId: string;
}

export interface RevertSummary {
  actor: string;
  counterparty: string;
  currency: string;
  currencyDelta: number;
  itemDeltas: Record<string, number>;
  originalReason: string;
}

export type RevertLedgerResult =
  | { ok: true; compensatingId: string; summary: RevertSummary }
  | { ok: false; reason: "not_found" | "already_reverted" };

interface LedgerRow {
  actor_kind: string;
  actor_id: string;
  counterparty_kind: string;
  counterparty_id: string;
  currency: string;
  currency_delta: number;
  item_deltas: Record<string, number>;
  reason: string;
}

export async function revertLedger(sql: Sql, req: RevertLedgerRequest): Promise<RevertLedgerResult> {
  return sql.begin(async (tx) => {
    const rows = await tx<LedgerRow[]>`
      SELECT actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason
        FROM ledger WHERE id = ${req.ledgerId}::bigint
    `;
    if (rows.length === 0) return { ok: false, reason: "not_found" } as const;
    const o = rows[0]!;

    // Idempotency: the compensating row is tagged with this marker; a second
    // revert of the same id finds it and refuses (no double-undo).
    const marker = `revert:${req.ledgerId}`;
    const already = await tx`SELECT 1 FROM ledger WHERE reason = ${marker} LIMIT 1`;
    if (already.length > 0) return { ok: false, reason: "already_reverted" } as const;

    const itemDeltas = o.item_deltas ?? {};

    // Undo the currency move — actor -= currency_delta, counterparty += it. Upsert
    // so a since-pruned party row is recreated (may go negative — god-mode).
    await tx`
      INSERT INTO balances (owner_kind, owner_id, currency, amount)
      VALUES (${o.actor_kind}, ${o.actor_id}, ${o.currency}, ${-o.currency_delta})
      ON CONFLICT (owner_kind, owner_id, currency) DO UPDATE SET amount = balances.amount - ${o.currency_delta}
    `;
    await tx`
      INSERT INTO balances (owner_kind, owner_id, currency, amount)
      VALUES (${o.counterparty_kind}, ${o.counterparty_id}, ${o.currency}, ${o.currency_delta})
      ON CONFLICT (owner_kind, owner_id, currency) DO UPDATE SET amount = balances.amount + ${o.currency_delta}
    `;

    // Undo each item move the same way.
    for (const [item, qty] of Object.entries(itemDeltas)) {
      await tx`
        INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
        VALUES (${o.actor_kind}, ${o.actor_id}, ${item}, ${-qty})
        ON CONFLICT (owner_kind, owner_id, item_id) DO UPDATE SET qty = inventories.qty - ${qty}
      `;
      await tx`
        INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
        VALUES (${o.counterparty_kind}, ${o.counterparty_id}, ${item}, ${qty})
        ON CONFLICT (owner_kind, owner_id, item_id) DO UPDATE SET qty = inventories.qty + ${qty}
      `;
    }

    // Append the compensating row (append-only ledger stays reconcilable): the
    // negated deltas from the same actor's perspective, tagged with the marker.
    const negatedItems = Object.fromEntries(Object.entries(itemDeltas).map(([k, v]) => [k, -v]));
    const comp = await tx`
      INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason)
      VALUES (
        ${o.actor_kind}, ${o.actor_id}, ${o.counterparty_kind}, ${o.counterparty_id},
        ${o.currency}, ${-o.currency_delta}, ${jsonParam(sql, negatedItems)}, ${marker}
      )
      RETURNING id
    `;

    return {
      ok: true,
      compensatingId: String(comp[0]!.id),
      summary: {
        actor: `${o.actor_kind}:${o.actor_id}`,
        counterparty: `${o.counterparty_kind}:${o.counterparty_id}`,
        currency: o.currency,
        currencyDelta: o.currency_delta,
        itemDeltas,
        originalReason: o.reason,
      },
    } as const;
  });
}
