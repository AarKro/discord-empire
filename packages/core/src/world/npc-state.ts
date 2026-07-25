/**
 * NPC state helpers (framework spec §5). Every bot/NPC owns a mutable `state`
 * jsonb column on its `npcs` row — the durable scratchpad for restart-surviving
 * surfaces: the stall's pinned message id, each player's open dialogue thread id
 * (render), a wanderer's position (travel). This module centralises the handful
 * of near-identical reads/writes so the jsonb plumbing isn't re-inlined per
 * capability. The DB is the position/surface truth; Discord only reflects it.
 */
import type { Sql } from "@empire/db";
import { jsonParam } from "@empire/db";

/** Read a bot/NPC's `state` jsonb (or `{}` when the row/column is absent). */
export async function readNpcState<T = Record<string, unknown>>(sql: Sql, npcId: string): Promise<T> {
  const [row] = await sql<{ state: T }[]>`SELECT state FROM npcs WHERE id = ${npcId}`;
  return row?.state ?? ({} as T);
}

/**
 * Upsert `state.<map>.<key> = value`, creating the nested map if it's absent.
 * The atomic jsonb_set keeps concurrent writers to DIFFERENT keys from
 * clobbering each other (e.g. two players' dialogue threads, or per-guild stall
 * messages). `value` is stored as a JSON string (ids are always strings here).
 */
export async function upsertNpcStateEntry(sql: Sql, npcId: string, map: string, key: string, value: string): Promise<void> {
  await sql`
    UPDATE npcs SET state = jsonb_set(
      jsonb_set(state, ARRAY[${map}], COALESCE(state->${map}, '{}'::jsonb)),
      ARRAY[${map}, ${key}],
      ${jsonParam(sql, value)}
    ) WHERE id = ${npcId}
  `;
}

/** Delete `state.<map>.<key>` (no-op if it isn't present). */
export async function deleteNpcStateEntry(sql: Sql, npcId: string, map: string, key: string): Promise<void> {
  await sql`UPDATE npcs SET state = state #- ARRAY[${map}, ${key}]::text[] WHERE id = ${npcId}`;
}

/** Where a travelling NPC stands relative to one player (see `npcProximity`). */
export interface NpcProximity {
  /** The continent the npc is on, or null when it's nowhere — "on the road" (§9). */
  npcGuild: string | null;
  /** The continent they SHARE, or null when they aren't standing together. */
  shared: string | null;
}

/**
 * Locate a TRAVELLING npc relative to a player. Both facts are returned because
 * callers tell them apart in fiction: a stranger who is mid-transit ("no stranger
 * stirs here") reads differently from one who is simply on another shore.
 *
 * This is the presence gate for the Secret Merchant's player-facing surfaces —
 * the first and cheapest LLM cost gate, since it's pure game state. Kept in one
 * place because `/approach`, `/riddle` and `riddle.deal` all ask it, and a copy
 * that drifted would let a player interact with an absent stranger.
 */
export async function npcProximity(sql: Sql, npcId: string, playerId: string): Promise<NpcProximity> {
  const state = await readNpcState<{ guild?: string | null }>(sql, npcId);
  const npcGuild = state.guild ?? null;
  if (!npcGuild) return { npcGuild: null, shared: null };
  const [player] = await sql<{ position_guild_id: string | null }[]>`
    SELECT position_guild_id FROM players WHERE discord_user_id = ${playerId}
  `;
  return { npcGuild, shared: (player?.position_guild_id ?? null) === npcGuild ? npcGuild : null };
}
