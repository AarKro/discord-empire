/**
 * Tick service (framework spec §3, §5-adjacent) — the idle-game heartbeat.
 * Emits scheduled events only: tick.minute / tick.hour, build.completed,
 * research.completed, and auction closings. Contains ZERO Discord code — it just
 * publishes onto the bus, which the bots (and their embedded workflows) react to.
 *
 * Re-delivery is deliberate: a due row keeps firing until the owning capability
 * flips it, which is how a build completes when its bot was down at the moment
 * the timer elapsed. To keep that from becoming an unbounded event-log leak when
 * nothing ever consumes the event (a lost or failed workflow instance), each
 * outstanding row is re-fired on an exponential backoff (see core's Backoff) and
 * warned about once it has clearly stopped making progress.
 */
import { Backoff, EventBus, rootLogger, type Logger } from "@empire/core";
import { openDb, type Sql } from "@empire/db";

/** Attempts after which an outstanding row is almost certainly stuck, not slow. */
const STUCK_AFTER_ATTEMPTS = 5;

/** How long a settled (final/failed) workflow instance is kept before pruning. */
const INSTANCE_RETENTION_DAYS = Number(process.env.WORKFLOW_RETENTION_DAYS ?? 7);

async function main(): Promise<void> {
  const log = rootLogger.child({ service: "tick-service" });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const { sql } = openDb(url);
  const bus = new EventBus(sql, "tick-service", log);

  // Tick service is a producer; it still subscribes so its own cursor advances,
  // but it does not need to react to anything.
  await bus.subscribe(() => {});

  // One backoff per due-work stream, keyed by the row that hasn't settled yet.
  const buildBackoff = new Backoff();
  const researchBackoff = new Backoff();
  const auctionBackoff = new Backoff();
  const musterBackoff = new Backoff();
  const arrivalBackoff = new Backoff();
  const returnBackoff = new Backoff();

  let minutes = 0;

  async function emitMinute(): Promise<void> {
    minutes += 1;
    await bus.publish({ type: "tick.minute", payload: { minute: minutes } });
    if (minutes % 60 === 0) {
      await bus.publish({ type: "tick.hour", payload: { hour: minutes / 60 } });
      await pruneSettledWorkflows(sql, log);
    }
    await fireDueBuilds();
    await fireDueResearch();
    await fireDueAuctions();
    await fireDueMusters();
    await fireDueArrivals();
    await fireDueReturns();
  }

  /**
   * Decide which of `keys` may fire this pass, and forget the ones that settled.
   * Rows past STUCK_AFTER_ATTEMPTS are surfaced so a wedged build/research shows
   * up in the logs rather than silently trickling events forever.
   */
  function filterDue(backoff: Backoff, keys: string[], stream: string): Set<string> {
    const now = Date.now();
    backoff.retain(keys); // anything that settled stops being tracked
    const firing = new Set<string>();
    for (const key of keys) {
      if (!backoff.due(key, now)) continue;
      firing.add(key);
      const attempts = backoff.attempts(key);
      if (attempts >= STUCK_AFTER_ATTEMPTS) {
        log.warn({ stream, key, attempts }, "due row is not settling; re-firing on backoff");
      }
    }
    return firing;
  }

  /** build.completed for any build whose timer has elapsed (§2.4, §10 Builder). */
  async function fireDueBuilds(): Promise<void> {
    const due = await sql<{ id: string; owner_id: string; blueprint_id: string; correlation_id: string | null }[]>`
      SELECT id, owner_id, blueprint_id, correlation_id FROM build_queue
      WHERE status = 'building' AND completes_at <= now()
    `;
    const firing = filterDue(buildBackoff, due.map((b) => b.id), "build");
    for (const b of due) {
      if (!firing.has(b.id)) continue;
      await bus.publish({
        type: "build.completed",
        actor: { kind: "player", id: b.owner_id },
        // Thread the build's correlation so the completion routes back to the
        // originating player_build instance among a player's concurrent builds.
        correlationId: b.correlation_id,
        payload: { queue_id: b.id, blueprint: b.blueprint_id },
      });
    }
  }

  /** research.completed for any node whose timer has elapsed (§4 Architect, §5). */
  async function fireDueResearch(): Promise<void> {
    const due = await sql<{ owner_id: string; research_id: string; correlation_id: string | null }[]>`
      SELECT owner_id, research_id, correlation_id FROM research
      WHERE status = 'in_progress' AND completes_at IS NOT NULL AND completes_at <= now()
    `;
    const key = (r: { owner_id: string; research_id: string }): string => `${r.owner_id}:${r.research_id}`;
    const firing = filterDue(researchBackoff, due.map(key), "research");
    for (const r of due) {
      if (!firing.has(key(r))) continue;
      await bus.publish({
        type: "research.completed",
        actor: { kind: "player", id: r.owner_id },
        // Thread the node's correlation so the completion routes back to the
        // originating architect_research instance among a player's concurrent runs.
        correlationId: r.correlation_id,
        payload: { node: r.research_id },
      });
    }
  }

  /** Close timed auctions whose expiry has passed (§5.11). */
  async function fireDueAuctions(): Promise<void> {
    const due = await sql<{ id: string }[]>`
      SELECT id FROM offers WHERE kind = 'auction' AND status = 'open' AND expires_at <= now()
    `;
    const firing = filterDue(auctionBackoff, due.map((a) => a.id), "auction");
    for (const a of due) {
      if (!firing.has(a.id)) continue;
      await bus.publish({ type: "auction.closed", payload: { offer_id: a.id } });
    }
  }

  /** muster.completed for any stack whose drill timer has elapsed (§2.6, §5.13). */
  async function fireDueMusters(): Promise<void> {
    const due = await sql<{ id: string; owner_id: string; correlation_id: string | null }[]>`
      SELECT id, owner_id, correlation_id FROM units
      WHERE status = 'training' AND ready_at IS NOT NULL AND ready_at <= now()
    `;
    const firing = filterDue(musterBackoff, due.map((u) => u.id), "muster");
    for (const u of due) {
      if (!firing.has(u.id)) continue;
      await bus.publish({
        type: "muster.completed",
        actor: { kind: "player", id: u.owner_id },
        // Thread the stack's correlation so the completion routes back to the
        // originating warden_muster instance among a player's concurrent drills.
        correlationId: u.correlation_id,
        payload: { unit_id: u.id },
      });
    }
  }

  /**
   * The dispatch primitive's two legs (§5.13). Both sweep the same table on
   * different columns: the outbound timer flips travelling → the fight, the
   * return timer brings the force home. Kept as separate streams (and separate
   * backoffs) because a wedged resolution must not stall unrelated returns.
   */
  async function fireDueArrivals(): Promise<void> {
    const due = await sql<{ id: string; owner_id: string; correlation_id: string | null }[]>`
      SELECT id, owner_id, correlation_id FROM dispatches
      WHERE status = 'travelling' AND arrives_at IS NOT NULL AND arrives_at <= now()
    `;
    const firing = filterDue(arrivalBackoff, due.map((d) => d.id), "dispatch-arrival");
    for (const d of due) {
      if (!firing.has(d.id)) continue;
      await bus.publish({
        type: "dispatch.arrived",
        actor: { kind: "player", id: d.owner_id },
        correlationId: d.correlation_id,
        payload: { dispatch_id: d.id },
      });
    }
  }

  async function fireDueReturns(): Promise<void> {
    const due = await sql<{ id: string; owner_id: string; correlation_id: string | null }[]>`
      SELECT id, owner_id, correlation_id FROM dispatches
      WHERE status = 'returning' AND returns_at IS NOT NULL AND returns_at <= now()
    `;
    const firing = filterDue(returnBackoff, due.map((d) => d.id), "dispatch-return");
    for (const d of due) {
      if (!firing.has(d.id)) continue;
      await bus.publish({
        type: "dispatch.returned",
        actor: { kind: "player", id: d.owner_id },
        correlationId: d.correlation_id,
        payload: { dispatch_id: d.id },
      });
    }
  }

  const intervalMs = Number(process.env.TICK_INTERVAL_MS ?? 60_000);
  const timer = setInterval(() => void emitMinute(), intervalMs);
  timer.unref?.();
  log.info({ intervalMs, retentionDays: INSTANCE_RETENTION_DAYS }, "tick service ready");
}

/**
 * Drop workflow instances that reached a terminal state a while ago (§7). Active
 * instances are the working set the runtime scans on every event; settled ones
 * are history, and the append-only event log remains the durable record of what
 * actually happened.
 */
async function pruneSettledWorkflows(sql: Sql, log: Logger): Promise<void> {
  try {
    const pruned = await sql`
      DELETE FROM workflow_instances
      WHERE status IN ('final', 'failed')
        AND updated_at < now() - ${`${INSTANCE_RETENTION_DAYS} days`}::interval
    `;
    if (pruned.count > 0) log.info({ pruned: pruned.count }, "pruned settled workflow instances");
  } catch (err) {
    log.warn({ err }, "workflow instance prune failed");
  }
}

main().catch((err) => {
  rootLogger.error({ err }, "tick service crashed");
  process.exit(1);
});
