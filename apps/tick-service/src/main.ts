/**
 * Tick service (framework spec §3, §5-adjacent) — the idle-game heartbeat.
 * Emits scheduled events only: tick.minute / tick.hour, build.completed,
 * stock.restocked, and auction closings. Contains ZERO Discord code — it just
 * publishes onto the bus, which the bots (and their embedded workflows) react to.
 */
import { EventBus, rootLogger } from "@empire/core";
import { openDb } from "@empire/db";

async function main(): Promise<void> {
  const log = rootLogger.child({ service: "tick-service" });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const { sql } = openDb(url);
  const bus = new EventBus(sql, "tick-service", log);

  // Tick service is a producer; it still subscribes so its own cursor advances,
  // but it does not need to react to anything.
  await bus.subscribe(() => {});

  let minutes = 0;

  async function emitMinute(): Promise<void> {
    minutes += 1;
    await bus.publish({ type: "tick.minute", payload: { minute: minutes } });
    if (minutes % 60 === 0) {
      await bus.publish({ type: "tick.hour", payload: { hour: minutes / 60 } });
    }
    await fireDueBuilds();
    await fireDueAuctions();
  }

  /** build.completed for any build whose timer has elapsed (§2.4, §10 Builder). */
  async function fireDueBuilds(): Promise<void> {
    const due = await sql<{ id: string; owner_id: string; blueprint_id: string; correlation_id: string | null }[]>`
      SELECT id, owner_id, blueprint_id, correlation_id FROM build_queue
      WHERE status = 'building' AND completes_at <= now()
    `;
    for (const b of due) {
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

  /** Close timed auctions whose expiry has passed (§5.11). */
  async function fireDueAuctions(): Promise<void> {
    const due = await sql<{ id: string }[]>`
      SELECT id FROM offers WHERE kind = 'auction' AND status = 'open' AND expires_at <= now()
    `;
    for (const a of due) {
      await bus.publish({ type: "auction.closed", payload: { offer_id: a.id } });
    }
  }

  const intervalMs = Number(process.env.TICK_INTERVAL_MS ?? 60_000);
  const timer = setInterval(() => void emitMinute(), intervalMs);
  timer.unref?.();
  log.info({ intervalMs }, "tick service ready");
}

main().catch((err) => {
  rootLogger.error({ err }, "tick service crashed");
  process.exit(1);
});
