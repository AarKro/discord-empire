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
 * The text channel of a player's land plot — where receipts, offers and trade
 * notices land (§5.9 notify, §5.11 market). Null when they hold no plot yet, or
 * it was never given a Discord surface.
 *
 * Pruned plots are excluded: their channel is deleted or archived, so the live
 * plot is the only deliverable one. Four call sites re-inlined this SELECT, and
 * each had to remember the `pruned = false` clause on its own.
 */
export async function landChannel(sql: Sql, playerId: string): Promise<string | null> {
  const [plot] = await sql<{ text_channel_id: string | null }[]>`
    SELECT text_channel_id FROM land_plots WHERE owner_id = ${playerId} AND pruned = false LIMIT 1
  `;
  return plot?.text_channel_id ?? null;
}

/**
 * The text channel of a player's land plot ON A SPECIFIC CONTINENT (§2.4: "land
 * can be held on any continent the player has unlocked").
 *
 * `landChannel` takes whichever plot comes first, which is right for a receipt —
 * any land channel of theirs will do. It is wrong when the surface belongs to a
 * particular continent: a caravan's stall is posted in the player's HOME plot
 * precisely because the wares are elsewhere, and picking an arbitrary plot could
 * put it on the very continent the caravan was sent to.
 */
export async function landChannelIn(sql: Sql, playerId: string, guildId: string): Promise<string | null> {
  const [plot] = await sql<{ text_channel_id: string | null }[]>`
    SELECT text_channel_id FROM land_plots
    WHERE owner_id = ${playerId} AND guild_id = ${guildId} AND pruned = false LIMIT 1
  `;
  return plot?.text_channel_id ?? null;
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
