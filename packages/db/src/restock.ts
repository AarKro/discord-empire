/**
 * Shop restock (framework spec §2.5, §3 `stock.restocked`) — goods entering the
 * world onto an NPC's shelf.
 *
 * This is the world→npc mirror of `grant.ts`'s world→player grant, and it exists
 * for the same reason: invariant #2 says balances and inventories are DERIVED
 * from the append-only ledger, so stock cannot simply appear. Every top-up is one
 * transaction that writes the shelf AND the row explaining it, which is what keeps
 * "where did these goods come from" answerable forever.
 *
 * It is deliberately NOT modelled as a price-0 trade from a `world` party. That
 * would reuse `executeTrade` untouched, but the atomic contract decrements the
 * SELLER's inventory — so `world` would need stock rows of its own, which merely
 * relocates the infinite-source problem and puts a ceiling on how many goods can
 * ever exist. `grantReward` already sets the precedent for a world-sourced write
 * living beside the trade contract rather than inside it.
 */
import { jsonParam } from "./client.js";
import type { Sql } from "./client.js";

/** The ledger reason every shop top-up is filed under. */
export const RESTOCK_REASON = "shop_restock";

export interface RestockSpec {
  /** The stock owner — a continent-qualified merchant id, or a permit sink's bot id. */
  npcId: string;
  itemId: string;
  qty: number;
}

/**
 * Add `qty` of `itemId` to `npcId`'s shelf and record where it came from.
 * A no-op for a non-positive qty, so a caller can hand us a computed amount
 * without guarding first.
 */
export async function restockShop(sql: Sql, spec: RestockSpec): Promise<void> {
  if (spec.qty <= 0) return;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
      VALUES ('npc', ${spec.npcId}, ${spec.itemId}, ${spec.qty})
      ON CONFLICT (owner_kind, owner_id, item_id) DO UPDATE SET qty = inventories.qty + ${spec.qty}
    `;
    await tx`
      INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason)
      VALUES ('npc', ${spec.npcId}, 'world', 'world', 'gold', 0,
              ${jsonParam(sql, { [spec.itemId]: spec.qty })}, ${RESTOCK_REASON})
    `;
  });
}
