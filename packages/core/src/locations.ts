/**
 * Location → Discord channel resolution (framework spec §8 guild+channel
 * mapping). The `locations` table is seeded by world:init; capabilities look up
 * the concrete channel for a guild's location of a given kind ('bazaar', 'land',
 * 'voice', …). Centralised here so the near-identical SELECT isn't re-inlined.
 */
import type { Sql } from "@empire/db";

/**
 * The Discord channel id for a guild's location of `kind`, or null when the row
 * isn't seeded (run world:init). `orderById` makes the pick deterministic when a
 * guild can hold several rows of the kind (e.g. multiple 'voice' channels) —
 * without it the single-row kinds just take the first match.
 */
export async function locationChannel(
  sql: Sql,
  guildId: string,
  kind: string,
  opts: { orderById?: boolean } = {},
): Promise<string | null> {
  const rows = opts.orderById
    ? await sql<{ channel_id: string | null }[]>`
        SELECT channel_id FROM locations WHERE guild_id = ${guildId} AND kind = ${kind} ORDER BY id LIMIT 1`
    : await sql<{ channel_id: string | null }[]>`
        SELECT channel_id FROM locations WHERE guild_id = ${guildId} AND kind = ${kind} LIMIT 1`;
  return rows[0]?.channel_id ?? null;
}

/**
 * The Discord voice-channel id for a logical wander/travel stop in a guild, or
 * null when unmapped (run world:init). world:init keys voice stops by
 * `<stop>_<guildId>` (kind='voice'), so a schedule/workflow stop name like
 * "market_square_vc" resolves to the real channel. Shared by presence.voice
 * (within-guild wander) and travel (cross-guild hop).
 */
export async function voiceStopChannel(
  sql: Sql,
  guildId: string,
  stop: string,
): Promise<string | null> {
  const rows = await sql<{ channel_id: string | null }[]>`
    SELECT channel_id FROM locations WHERE id = ${`${stop}_${guildId}`} AND kind = 'voice' LIMIT 1`;
  return rows[0]?.channel_id ?? null;
}
