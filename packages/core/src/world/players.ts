/**
 * Small reads over the `players` row (framework spec §2.1, §2.3, §8).
 *
 * Position is pure DB state and Discord only reflects it, so "where does this
 * player stand" and "what tier are they" are questions several capabilities ask
 * in passing. Centralised so the same one-line SELECT isn't re-inlined per call
 * site — the same reason `locations.ts` exists.
 *
 * The richer read (gold, reputation, flags, research) is `loadGuardScope` in
 * dialogue/guards.ts, which stays there because it exists to feed guard
 * evaluation.
 */
import type { Sql } from "@empire/db";

/**
 * Idle pacing is hybrid: higher tiers take LONGER to build and research (§2.5).
 *
 * One formula, deliberately: builds and research each had their own copy with
 * an identical body, so tuning the curve for one and forgetting the other would
 * have silently desynced the two progression tracks — a balance bug that no
 * test would catch, because each had its own test asserting its own copy.
 */
export function tierScaledMs(baseMs: number, tier: number): number {
  return Math.round(baseMs * (1 + 0.5 * (tier - 1)));
}

/** The player's progression tier (§2.5); an unregistered player is tier 1. */
export async function playerTier(sql: Sql, playerId: string): Promise<number> {
  const [row] = await sql<{ tier: number }[]>`
    SELECT tier FROM players WHERE discord_user_id = ${playerId}
  `;
  return row?.tier ?? 1;
}

/**
 * The continent the player currently stands on, or `fallback` when they have no
 * position on record. NULL position means mid-transit ("on the road", §9), so a
 * caller passing the acting event's guild gets sensible behaviour either way.
 */
export async function currentGuildId(
  sql: Sql,
  playerId: string,
  fallback: string | null,
): Promise<string | null> {
  const [row] = await sql<{ position_guild_id: string | null }[]>`
    SELECT position_guild_id FROM players WHERE discord_user_id = ${playerId}
  `;
  return row?.position_guild_id ?? fallback;
}
