/**
 * The global cost ceiling on LLM dialogue (framework spec §11). Every real API
 * call — a stranger's line, a riddle hint, a riddle answer-judgement — emits
 * `dialogue.generated`, and this counts them over a rolling hour. One definition
 * lives here so the gate can't drift apart between callers: a second breaker with
 * its own counter would silently double the spend it was added to prevent.
 *
 * Deliberately a plain COUNT over the events table — no new table, no migration,
 * and auditable through the Ops bot's /admin-events.
 */
import type { Sql } from "@empire/db";

/** Default hourly ceiling on real generations; override with DIALOGUE_MAX_PER_HOUR. */
export const DEFAULT_MAX_PER_HOUR = 30;

/** The configured ceiling, falling back to the default on an unset/garbage value. */
export function maxPerHour(): number {
  const raw = Number(process.env.DIALOGUE_MAX_PER_HOUR);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_PER_HOUR;
}

/**
 * True when the hourly ceiling is already spent, so the caller must fall back to
 * authored content. Counts `dialogue.generated` across every bot and feature.
 */
export async function overHourlyCap(sql: Sql): Promise<boolean> {
  const [recent] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM events
     WHERE type = 'dialogue.generated' AND ts > now() - interval '1 hour'
  `;
  return (recent?.n ?? 0) >= maxPerHour();
}
