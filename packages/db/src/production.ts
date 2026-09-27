/**
 * Banking building production (framework spec §2.4) — goods entering the world
 * into a player's packs.
 *
 * The world→player sibling of `grant.ts` and `restock.ts`, for the same reason:
 * inventories are DERIVED from the append-only ledger (invariant #2), so goods
 * cannot simply appear. One /collect is one transaction that locks the player's
 * producing buildings, advances each one's clock, adds the goods and writes ONE
 * ledger row naming all of them — a collect is a single auditable event however
 * many buildings contributed.
 *
 * The accrual rule itself is pure and lives in @empire/core (world/production.ts);
 * it is passed in so this package stays free of game policy.
 */
import { jsonParam } from "./client.js";
import type { Sql } from "./client.js";

/** The ledger reason every collect is filed under. */
export const PRODUCTION_REASON = "production";

export interface ProducingBuilding {
  id: string;
  blueprintId: string;
  produces: { item: string; per_hour: number; cap: number };
  /** The building's clock after this collect (unchanged if nothing was banked). */
  since: Date;
}

export interface CollectResult {
  /** The instant the collect was computed at — the database's clock. */
  now: Date;
  /** item → qty banked by this collect (empty when the stores were bare). */
  gathered: Record<string, number>;
  /** Every producing building the player holds, with its post-collect clock. */
  buildings: ProducingBuilding[];
}

export type AccrueFn = (
  produces: ProducingBuilding["produces"],
  since: Date,
  now: Date,
) => { amount: number; since: Date };

/**
 * Bank `playerId`'s production. `now` defaults to the DATABASE's clock, read
 * inside the transaction: the building clocks are stamped by Postgres (`now()`
 * at completion), so measuring against the app host's clock would let a few ms
 * of skew shave a unit off a collect that lands exactly on a boundary.
 */
export async function collectProduction(sql: Sql, playerId: string, accrue: AccrueFn, at?: Date): Promise<CollectResult> {
  return sql.begin(async (tx) => {
    // (Wrapped: the driver may hand a timestamptz back as a string.)
    const now = at ?? new Date((await tx<{ now: Date | string }[]>`SELECT now() AS now`)[0]!.now);
    // FOR UPDATE: two /collects racing serialise here, so the second sees the
    // clocks the first advanced and banks nothing twice.
    const rows = await tx<{ id: string; blueprint_id: string; produces: ProducingBuilding["produces"]; last_collected_at: Date | null }[]>`
      SELECT bq.id::text AS id, bq.blueprint_id, bc.produces, bq.last_collected_at
      FROM build_queue bq JOIN blueprint_catalog bc ON bc.id = bq.blueprint_id
      WHERE bq.owner_id = ${playerId} AND bq.status = 'completed' AND bc.produces IS NOT NULL
      ORDER BY bq.id
      FOR UPDATE OF bq
    `;
    const gathered: Record<string, number> = {};
    const buildings: ProducingBuilding[] = [];
    for (const row of rows) {
      // A completed building with no clock (it can't happen after the 0002
      // backfill, but a NULL must never read as "since the epoch") starts now.
      const since = row.last_collected_at ? new Date(row.last_collected_at) : now;
      const out = row.last_collected_at ? accrue(row.produces, since, now) : { amount: 0, since: now };
      if (out.amount > 0 || !row.last_collected_at) {
        await tx`UPDATE build_queue SET last_collected_at = ${out.since.toISOString()} WHERE id = ${row.id}`;
      }
      if (out.amount > 0) gathered[row.produces.item] = (gathered[row.produces.item] ?? 0) + out.amount;
      buildings.push({ id: row.id, blueprintId: row.blueprint_id, produces: row.produces, since: out.since });
    }
    if (Object.keys(gathered).length === 0) return { now, gathered, buildings };

    for (const [item, qty] of Object.entries(gathered)) {
      await tx`
        INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
        VALUES ('player', ${playerId}, ${item}, ${qty})
        ON CONFLICT (owner_kind, owner_id, item_id) DO UPDATE SET qty = inventories.qty + ${qty}
      `;
    }
    await tx`
      INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason)
      VALUES ('player', ${playerId}, 'world', 'world', 'gold', 0, ${jsonParam(sql, gathered)}, ${PRODUCTION_REASON})
    `;
    return { now, gathered, buildings };
  });
}
