/**
 * Exponential backoff for repeated, self-healing work (tick service, §3).
 *
 * The tick service re-publishes completion events for rows whose timer elapsed
 * and keeps doing so until the owning capability flips the row — that redelivery
 * IS the recovery path when a bot was down at the moment the timer fired, so it
 * must not be dropped. But when nothing ever consumes the event (a lost or
 * failed workflow instance), an unthrottled re-fire writes one event row per
 * minute forever.
 *
 * This keeps both properties: fire immediately the first time, then back off
 * geometrically up to a ceiling, so a genuinely stuck row costs a handful of
 * events an hour instead of sixty, and a recoverable one still recovers.
 *
 * State is in-memory and per-process on purpose: a restarted tick service should
 * retry promptly (the restart is itself evidence something changed).
 */
export interface BackoffOptions {
  /** Delay before the second attempt; doubles from there. */
  baseMs?: number;
  /** Ceiling on the delay between attempts. */
  maxMs?: number;
}

const DEFAULT_BASE_MS = 60_000; // one tick
const DEFAULT_MAX_MS = 30 * 60_000; // half an hour

export class Backoff {
  private readonly state = new Map<string, { attempts: number; nextAt: number }>();
  private readonly baseMs: number;
  private readonly maxMs: number;

  constructor(opts: BackoffOptions = {}) {
    this.baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
    this.maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  }

  /**
   * Whether `key` may fire at `now`. A first sighting always fires; later ones
   * only once the current delay has elapsed. Calling this RECORDS the attempt,
   * so it must be called exactly once per key per pass.
   */
  due(key: string, now: number): boolean {
    const prev = this.state.get(key);
    if (!prev) {
      this.state.set(key, { attempts: 1, nextAt: now + this.baseMs });
      return true;
    }
    if (now < prev.nextAt) return false;
    const attempts = prev.attempts + 1;
    // attempts=1 already waited baseMs; each further attempt doubles, to maxMs.
    const delay = Math.min(this.baseMs * 2 ** (attempts - 1), this.maxMs);
    this.state.set(key, { attempts, nextAt: now + delay });
    return true;
  }

  /** How many times `key` has fired (0 if unseen) — for observability. */
  attempts(key: string): number {
    return this.state.get(key)?.attempts ?? 0;
  }

  /**
   * Drop every key not in `live`. Work that completed stops being tracked, so a
   * key that legitimately recurs later starts from a clean, immediate retry.
   */
  retain(live: Iterable<string>): void {
    const keep = new Set(live);
    for (const key of this.state.keys()) {
      if (!keep.has(key)) this.state.delete(key);
    }
  }

  /** Number of keys currently being tracked (i.e. still outstanding). */
  get size(): number {
    return this.state.size;
  }
}
