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
 *
 * The ids live HERE rather than in the capability that spends each one, because
 * the list needs all three: sourcing them from capabilities/ meant world/ and
 * capabilities/ imported each other. world-init wants two of them as well, to
 * stock the permit-sink NPCs, and it has no business loading a whole capability
 * to read a string.
 */

/** The single-use item a builder "sells" the player for a build (§2.5). */
export const BUILD_PERMIT_ITEM = "build_permit";

/** The Architect's equivalent, sold once per queued research node. */
export const RESEARCH_PERMIT_ITEM = "research_permit";

/** The token whose "sale" escrows a bidder's gold for the life of a bid. */
export const AUCTION_HOLD_ITEM = "auction_bid";

/** The Warden's equivalent, "sold" once per muster to charge for troops (§5.13). */
export const MUSTER_PERMIT_ITEM = "muster_permit";

/** Every internal token, for `item_id <> ALL(${HIDDEN_ITEMS})` filters. */
export const HIDDEN_ITEMS: readonly string[] = [
  BUILD_PERMIT_ITEM,
  RESEARCH_PERMIT_ITEM,
  AUCTION_HOLD_ITEM,
  MUSTER_PERMIT_ITEM,
];

/** True when `itemId` is internal plumbing and must stay out of player-facing UI. */
export function isHiddenItem(itemId: string): boolean {
  return HIDDEN_ITEMS.includes(itemId);
}
