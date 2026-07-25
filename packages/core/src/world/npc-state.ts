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
