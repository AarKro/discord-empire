/**
 * Crafting (framework spec §2.6 champion gear) — goods and gold in, one item out.
 *
 * Like buy-back and production, a world-facing write beside the trade contract:
 * the inputs are CONSUMED (they go to no one), so there is no counterparty
 * inventory for executeTrade to credit. One transaction, one ledger row naming
 * every delta, and a conditional decrement per input and for the gold — any
 * shortfall rolls the whole craft back, so a race for the last inputs can only
 * be paid once.
 */
import { jsonParam } from "./client.js";
import type { Sql } from "./client.js";

/** The ledger reason every craft is filed under. */
export const CRAFT_REASON = "craft";

export interface CraftSpec {
  player: string;
  /** item → qty consumed. */
  inputs: Record<string, number>;
  gold: number;
  /** The item made (one unit). */
  output: string;
}

export type CraftResult =
  | { ok: true }
  | { ok: false; reason: "insufficient_items"; item: string }
  | { ok: false; reason: "insufficient_funds" };

/** Thrown inside the transaction to roll it back, then turned into a result. */
class Shortfall extends Error {
  constructor(readonly result: Exclude<CraftResult, { ok: true }>) {
    super("craft shortfall");
  }
}

export async function craftItem(sql: Sql, spec: CraftSpec): Promise<CraftResult> {
  try {
    await sql.begin(async (tx) => {
      for (const [item, qty] of Object.entries(spec.inputs)) {
        const taken = await tx`
          UPDATE inventories SET qty = qty - ${qty}
          WHERE owner_kind = 'player' AND owner_id = ${spec.player} AND item_id = ${item} AND qty >= ${qty}
          RETURNING qty
        `;
        if (taken.length === 0) throw new Shortfall({ ok: false, reason: "insufficient_items", item });
      }
      if (spec.gold > 0) {
        const paid = await tx`
          UPDATE balances SET amount = amount - ${spec.gold}
          WHERE owner_kind = 'player' AND owner_id = ${spec.player} AND currency = 'gold' AND amount >= ${spec.gold}
          RETURNING amount
        `;
        if (paid.length === 0) throw new Shortfall({ ok: false, reason: "insufficient_funds" });
      }
      await tx`
        INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
        VALUES ('player', ${spec.player}, ${spec.output}, 1)
        ON CONFLICT (owner_kind, owner_id, item_id) DO UPDATE SET qty = inventories.qty + 1
      `;
      // Actor gains +deltas (revert.ts convention): inputs negative, output +1.
      const deltas: Record<string, number> = {};
      for (const [item, qty] of Object.entries(spec.inputs)) deltas[item] = -qty;
      deltas[spec.output] = (deltas[spec.output] ?? 0) + 1;
      await tx`
        INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason)
        VALUES ('player', ${spec.player}, 'world', 'world', 'gold', ${-spec.gold}, ${jsonParam(sql, deltas)}, ${CRAFT_REASON})
      `;
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof Shortfall) return err.result;
    throw err;
  }
}
