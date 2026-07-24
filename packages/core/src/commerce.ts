/**
 * Cross-continent commerce guard (framework spec §2.3). Transacting on the global
 * market or auctions of a continent that is NOT your home requires progression:
 * the Observer role alone never suffices. This slice enforces the first two of the
 * three gates the spec lists — `trade_routes` research and a built Trade Post — and
 * leaves the "agent on site" gate for later.
 *
 * A pure eligibility check (reads only), returning an in-fiction rejection message
 * when blocked or null when the deal may proceed. Callers reply with the message
 * and abort BEFORE claiming the offer, so a blocked buy consumes nothing.
 */
import type { Sql } from "@empire/db";

/** Content ids of the gating research node and building (see world-init seeds). */
export const TRADE_ROUTES_RESEARCH = "trade_routes";
export const TRADE_POST_BLUEPRINT = "trade_post";

/**
 * Null if `playerId` may transact on `offerGuildId`, else the in-fiction reason.
 * Same-continent trade (or an offer with no continent) is always allowed; only
 * reaching into a continent other than the player's home is gated.
 */
export async function crossContinentCommerceBlock(
  sql: Sql,
  playerId: string,
  offerGuildId: string | null,
): Promise<string | null> {
  if (!offerGuildId) return null;
  const [player] = await sql<{ home_guild_id: string }[]>`
    SELECT home_guild_id FROM players WHERE discord_user_id = ${playerId}
  `;
  // No home on record yet → treat this as their home continent (nothing to gate).
  if (!player || player.home_guild_id === offerGuildId) return null;

  const [researched] = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM research
    WHERE owner_id = ${playerId} AND research_id = ${TRADE_ROUTES_RESEARCH} AND status = 'done' LIMIT 1
  `;
  if (!researched) return "Distant markets are beyond your reach — chart the trade routes first (see the Architect).";

  const [built] = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM build_queue
    WHERE owner_id = ${playerId} AND blueprint_id = ${TRADE_POST_BLUEPRINT} AND status = 'completed' LIMIT 1
  `;
  if (!built) return "You've no Trade Post to run distant trade through — build one first (see the Builder).";

  return null;
}
