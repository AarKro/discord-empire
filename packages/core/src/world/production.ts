/**
 * Building production (framework spec §2.4, §2.5) — the idle half of the idle
 * game. A completed producing building fills a store over time, up to a cap, and
 * /collect banks it. Nothing is written per tick: the store is a pure function of
 * the building's clock (`build_queue.last_collected_at`) and the wall clock.
 *
 * Pure, and the single place the policy lives; `collectProduction` in
 * @empire/db does the locking and the ledgered write around it.
 */

export interface Production {
  item: string;
  per_hour: number;
  cap: number;
}

export interface Accrual {
  /** Whole units ready to bank. */
  amount: number;
  /** The building's clock after banking them. */
  since: Date;
}

const HOUR_MS = 3_600_000;

/**
 * What a building has accrued since `since`, and where its clock should move.
 *
 * Two rules, both learned from restock:
 *   - the clock advances by the WHOLE units taken, not to `now` — otherwise the
 *     fraction of a unit already underway is thrown away on every collect and a
 *     player who checks in often earns less than the authored rate;
 *   - a FULL store stops accruing. Its clock jumps to `now`, and anything past
 *     the cap is lost, which is what makes the cap the check-in rhythm.
 */
export function accrued(p: Production, since: Date, now: Date): Accrual {
  if (p.per_hour <= 0 || p.cap <= 0) return { amount: 0, since };
  const msPerUnit = HOUR_MS / p.per_hour;
  const elapsed = Math.max(0, now.getTime() - since.getTime());
  const units = Math.floor(elapsed / msPerUnit);
  if (units >= p.cap) return { amount: p.cap, since: now };
  return { amount: units, since: new Date(since.getTime() + units * msPerUnit) };
}

/** Milliseconds until the next whole unit, from a clock just advanced by `accrued`. */
export function msToNextUnit(p: Production, since: Date, now: Date): number {
  const msPerUnit = HOUR_MS / p.per_hour;
  const elapsed = Math.max(0, now.getTime() - since.getTime());
  return Math.max(0, msPerUnit - (elapsed % msPerUnit));
}
