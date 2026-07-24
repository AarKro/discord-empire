/**
 * Internal (non-diegetic) item ids — the tokens the economy uses as plumbing
 * rather than as things a player owns.
 *
 * Several mechanics model a cost or a hold as a TRADE, because that keeps every
 * ledger write inside the vetted atomic writer (invariant #2) and gets the
 * funds/stock guards for free. The price of that trick is a token landing in a
 * real inventory row: a build permit, a research permit, an auction hold token.
 *
 * They must never surface in a player-facing list. This is the ONE list of them,
 * so `/inventory`, item autocomplete, and anything else that reads a player's
 * packs can't drift apart the way they did when each call site kept its own.
 */
import { BUILD_PERMIT_ITEM } from "./capabilities/land.js";
import { RESEARCH_PERMIT_ITEM } from "./capabilities/research.js";
import { AUCTION_HOLD_ITEM } from "./capabilities/auction.js";

/** Every internal token, for `item_id <> ALL(${HIDDEN_ITEMS})` filters. */
export const HIDDEN_ITEMS: readonly string[] = [
  BUILD_PERMIT_ITEM,
  RESEARCH_PERMIT_ITEM,
  AUCTION_HOLD_ITEM,
];

/** True when `itemId` is internal plumbing and must stay out of player-facing UI. */
export function isHiddenItem(itemId: string): boolean {
  return HIDDEN_ITEMS.includes(itemId);
}
