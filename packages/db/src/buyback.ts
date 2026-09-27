/**
 * Merchant buy-back (framework spec §2.5) — a player turning goods into gold at
 * an NPC's stall.
 *
 * The gold is WORLD-backed: the merchant always buys, at a spread below its sell
 * price, and the coin enters the economy here (a faucet, like combat rewards and
 * production) rather than coming out of the merchant's own purse — a purse fed
 * only by other players' spending would run dry in a small realm and make selling
 * silently fail. The spread and the regional price are policy and live in
 * @empire/core (world/goods.ts); this is only the atomic write.
 *
 * It sits beside the trade contract rather than inside it for the reason
 * `restock.ts` gives: executeTrade debits the BUYER's balance, and `world` has
 * none. The goods leave the player's packs (they are consumed, not stocked — a
 * merchant that resold them would be a second, unpriced shop).
 */
import { jsonParam } from "./client.js";
import type { Sql } from "./client.js";

/** The ledger reason every sale to a merchant is filed under. */
export const BUYBACK_REASON = "npc_buyback";

export interface SellToWorldSpec {
  player: string;
  itemId: string;
  qty: number;
  /** Total gold paid for the lot. */
  gold: number;
}

export type SellToWorldResult = { ok: true } | { ok: false; reason: "insufficient_items" | "invalid" };

/**
 * Take `qty` of `itemId` from the player and pay `gold`, atomically. The
 * conditional decrement (`WHERE qty >= :qty`) is the guard: two sells racing for
 * the same last units can't both land, and an over-sell changes nothing.
 */
export async function sellToWorld(sql: Sql, spec: SellToWorldSpec): Promise<SellToWorldResult> {
  if (!Number.isInteger(spec.qty) || spec.qty <= 0 || !Number.isInteger(spec.gold) || spec.gold < 0) {
    return { ok: false, reason: "invalid" };
  }
  return sql.begin(async (tx) => {
    const taken = await tx`
      UPDATE inventories SET qty = qty - ${spec.qty}
      WHERE owner_kind = 'player' AND owner_id = ${spec.player} AND item_id = ${spec.itemId} AND qty >= ${spec.qty}
      RETURNING qty
    `;
    if (taken.length === 0) return { ok: false, reason: "insufficient_items" } as const;
    if (spec.gold > 0) {
      await tx`
        INSERT INTO balances (owner_kind, owner_id, currency, amount)
        VALUES ('player', ${spec.player}, 'gold', ${spec.gold})
        ON CONFLICT (owner_kind, owner_id, currency) DO UPDATE SET amount = balances.amount + ${spec.gold}
      `;
    }
    // Ledger convention (see revert.ts): the actor gains +deltas, so the goods
    // leaving the player are a NEGATIVE item delta and the gold a positive one.
    await tx`
      INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason)
      VALUES ('player', ${spec.player}, 'world', 'world', 'gold', ${spec.gold},
              ${jsonParam(sql, { [spec.itemId]: -spec.qty })}, ${BUYBACK_REASON})
    `;
    return { ok: true } as const;
  });
}
