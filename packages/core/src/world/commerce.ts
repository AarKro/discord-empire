/**
 * Cross-continent commerce guard (framework spec §2.3). Transacting on the global
 * market or auctions of a continent that is NOT your home requires progression:
 * the Observer role alone never suffices. The spec lists three gates —
 * `trade_routes` research, a built Trade Post, and "later an agent on site" — and
 * all three are now enforced.
 *
 * A pure eligibility check (reads only), returning an in-fiction rejection message
 * when blocked or null when the deal may proceed. Callers reply with the message
 * and abort BEFORE claiming the offer, so a blocked buy consumes nothing.
 *
 * The split matters: sending a caravan is itself cross-continent commerce, so if
 * `caravan.send` called the full check it could never send the first one. It
 * calls `tradeRoutesAndPostBlock` instead — the two gates that precede having an
 * agent — and the full guard composes that with the agent check for everyone else.
 */
import type { Sql } from "@empire/db";

/** Content ids of the gating research node and building (see world-init seeds). */
export const TRADE_ROUTES_RESEARCH = "trade_routes";
export const TRADE_POST_BLUEPRINT = "trade_post";

/**
 * The two gates that come BEFORE having an agent abroad: `trade_routes` research
 * and a completed Trade Post. Null when they pass or when the continent is the
 * player's own (nothing to gate).
 */
export async function tradeRoutesAndPostBlock(
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

/**
 * Null if `playerId` may transact on `offerGuildId`, else the in-fiction reason.
 * Same-continent trade (or an offer with no continent) is always allowed; only
 * reaching into a continent other than the player's home is gated.
 *
 * The third gate is a caravan STANDING on that continent right now — §2.3's third
 * presence tier is being there "(or, in the future, an agent unit acting for
 * you)". Recalling a caravan therefore closes that market again, which is the
 * point: the posting is what buys the access, not a one-time unlock.
 */
export async function crossContinentCommerceBlock(
  sql: Sql,
  playerId: string,
  offerGuildId: string | null,
): Promise<string | null> {
  const prerequisite = await tradeRoutesAndPostBlock(sql, playerId, offerGuildId);
  if (prerequisite) return prerequisite;
  // Passed above means either the gates are met or there is nothing to gate
  // (own continent / no continent) — re-check which, so a home-market deal isn't
  // asked for a caravan it would never need.
  if (!offerGuildId) return null;
  const [player] = await sql<{ home_guild_id: string }[]>`
    SELECT home_guild_id FROM players WHERE discord_user_id = ${playerId}
  `;
  if (!player || player.home_guild_id === offerGuildId) return null;

  const [posted] = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM dispatches
    WHERE owner_id = ${playerId} AND status = 'stationed' AND mission->>'kind' = 'caravan'
      AND mission->>'destination_guild_id' = ${offerGuildId} LIMIT 1
  `;
  if (!posted) return "You've no agent in that market — send a caravan there first (`/caravan`).";

  return null;
}
