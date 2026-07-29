/**
 * The shared half of the dispatch primitive (framework spec §5.13). A dispatch
 * row is a force + a position + a timer + a MISSION, and §5.13 calls the unit
 * "the game's general-purpose 'send someone' mechanic (fights now, trade agents
 * later)". Two capabilities now ride it — `combat` (mission kind `battle`) and
 * `caravan` (kind `caravan`) — living in different bots, so the parts neither
 * owns exclusively belong here rather than in whichever one wrote them first.
 *
 * Every claim is filtered by mission kind. The tick sweeps `dispatches` by
 * status alone and publishes dispatch.arrived / dispatch.returned for whatever
 * is due, so the claiming UPDATE is the only thing standing between a mission
 * and a verb that was never meant to touch it. The workflow runtime's
 * correlation gate usually keeps the two apart, but it only engages when BOTH
 * the event and the instance carry a correlation id — so kind-filtering here is
 * what makes the separation hold unconditionally.
 */
import type { Sql } from "@empire/db";

/**
 * The unit-bearing shape every mission's force snapshot has in common. Missions
 * are free to carry more (combat's adds stat blocks the resolver needs); this is
 * the slice the shared legs read, so a caravan never has to model a champion it
 * doesn't take.
 */
export interface DispatchForceUnits {
  champion?: { unitId?: string | null } | null;
  troops?: { unitId?: string | null }[];
}

/** The unit ids a force snapshot ties up, champion first. */
export function forceUnitIds(force: DispatchForceUnits | null | undefined): string[] {
  return [
    ...(force?.champion?.unitId ? [force.champion.unitId] : []),
    ...(force?.troops ?? []).flatMap((t) => (t.unitId ? [t.unitId] : [])),
  ];
}

export interface ReturnedDispatch {
  ownerId: string;
  /** The units actually released by this call. */
  unitIds: string[];
}

/**
 * Claim the returning→done leg for a mission of `kind` and free exactly the
 * units its force took. Null when the claim found nothing — a redelivered tick,
 * or another kind's dispatch that this verb has no business closing.
 *
 * Releasing by snapshotted id (never a blanket "all this player's dispatched
 * units") is what lets a player hold a caravan abroad while their army fights
 * somewhere else: each mission frees only what it took.
 */
export async function returnDispatch(sql: Sql, dispatchId: string, kind: string): Promise<ReturnedDispatch | null> {
  const [row] = await sql<{ owner_id: string; force: DispatchForceUnits }[]>`
    UPDATE dispatches SET status = 'done'
    WHERE id = ${dispatchId} AND status = 'returning' AND mission->>'kind' = ${kind}
    RETURNING owner_id, force
  `;
  if (!row) return null;
  const unitIds = forceUnitIds(row.force);
  if (unitIds.length > 0) {
    await sql`UPDATE units SET status = 'idle' WHERE id = ANY(${unitIds}) AND status = 'dispatched'`;
  }
  return { ownerId: row.owner_id, unitIds };
}
