/**
 * Event bus over Postgres LISTEN/NOTIFY behind publish()/subscribe()
 * (framework spec §3, tech spec §Event bus).
 *
 * Delivery guarantees implemented here:
 *   - Every event is persisted to the append-only `events` table with a
 *     monotonic bigserial id.
 *   - NOTIFY payloads carry only the event's bigserial id; the consumer reads
 *     the full row (sidesteps the ~8KB NOTIFY payload cap).
 *   - Boot sequence for lossless restarts:
 *       1. LISTEN first, buffering any live notifications,
 *       2. replay all events with id > lastProcessedId,
 *       3. drain the live buffer, de-duplicating by event id,
 *       4. persist the new cursor after each successfully handled event.
 *
 * `publish()` accepts an optional transaction so callers that must emit inside
 * an existing transaction (transactional emit — an announced trade is a
 * committed trade) can do so; the ledger's trade helper emits directly in SQL.
 */
import type { Sql } from "@empire/db";
import { jsonParam } from "@empire/db";
import { ulid } from "ulid";
import type { Logger } from "./logger.js";
import { rootLogger, withCorrelation } from "./logger.js";

export const CHANNEL = "empire_events";

export interface BusEvent {
  /** Monotonic bigserial id (as string) — the replay/de-dup key. */
  dbId: string;
  /** Public event id (evt_/ULID) from the envelope. */
  eventId: string;
  type: string;
  ts: string;
  guildId: string | null;
  actor: { kind: string; id: string } | null;
  subject: { kind: string; id: string } | null;
  payload: Record<string, unknown>;
  correlationId: string | null;
}

export interface PublishInput {
  type: string;
  /**
   * Optional envelope fields accept `null` as well as `undefined` so callers can
   * forward a nullable source (`evt.guildId`, `evt.correlationId`) directly
   * instead of hand-rolling `...(x ? { x } : {})` spreads — publish() coalesces
   * either to the column's NULL below.
   */
  guildId?: string | null | undefined;
  actor?: { kind: string; id: string } | null | undefined;
  subject?: { kind: string; id: string } | null | undefined;
  payload?: Record<string, unknown> | null | undefined;
  correlationId?: string | null | undefined;
  /** Provide a public event id explicitly; otherwise a ULID is generated. */
  eventId?: string;
}

export type EventHandler = (evt: BusEvent) => Promise<void> | void;

interface Row {
  id: string | bigint;
  event_id: string;
  type: string;
  ts: Date | string;
  guild_id: string | null;
  actor_kind: string | null;
  actor_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  correlation_id: string | null;
}

function toEvent(row: Row): BusEvent {
  return {
    dbId: String(row.id),
    eventId: row.event_id,
    type: row.type,
    ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    guildId: row.guild_id,
    actor: row.actor_kind && row.actor_id ? { kind: row.actor_kind, id: row.actor_id } : null,
    subject: row.subject_kind && row.subject_id ? { kind: row.subject_kind, id: row.subject_id } : null,
    payload: row.payload ?? {},
    correlationId: row.correlation_id,
  };
}

/** How many backlog rows one drain query pulls before looping for more. */
const DRAIN_BATCH = 500;

export class EventBus {
  private listen: { unlisten: () => Promise<void> } | null = null;
  private draining = false;
  /** A notification arrived while draining — go round once more when it ends. */
  private pending = false;
  private started = false;
  private lastProcessedId = 0n;

  constructor(
    private readonly sql: Sql,
    private readonly consumer: string,
    private readonly log: Logger = rootLogger.child({ component: "bus", consumer: "" }),
  ) {}

  /**
   * Persist + announce an event. `id` is monotonic; NOTIFY carries only the id.
   * If `tx` is supplied the write happens inside that transaction (transactional
   * emit); otherwise it uses the bus connection.
   */
  async publish(input: PublishInput, tx?: Sql): Promise<BusEvent> {
    const runner = tx ?? this.sql;
    const eventId = input.eventId ?? `evt_${ulid()}`;
    const rows = await runner<Row[]>`
      INSERT INTO events (event_id, type, guild_id, actor_kind, actor_id, subject_kind, subject_id, payload, correlation_id)
      VALUES (
        ${eventId}, ${input.type}, ${input.guildId ?? null},
        ${input.actor?.kind ?? null}, ${input.actor?.id ?? null},
        ${input.subject?.kind ?? null}, ${input.subject?.id ?? null},
        ${jsonParam(runner, input.payload ?? {})}, ${input.correlationId ?? null}
      )
      RETURNING *
    `;
    const evt = toEvent(rows[0]!);
    await runner`SELECT pg_notify(${CHANNEL}, ${evt.dbId})`;
    return evt;
  }

  /**
   * Subscribe with the lossless boot sequence. Returns once replay + buffer
   * drain are complete; live events continue to flow to `handler` afterward.
   */
  async subscribe(handler: EventHandler): Promise<void> {
    if (this.started) throw new Error("bus already started");
    this.started = true;

    const [cursor] = await this.sql<{ last_processed_id: string | bigint }[]>`
      INSERT INTO bus_cursors (consumer) VALUES (${this.consumer})
      ON CONFLICT (consumer) DO UPDATE SET consumer = EXCLUDED.consumer
      RETURNING last_processed_id
    `;
    this.lastProcessedId = BigInt(cursor?.last_processed_id ?? 0);

    // A cursor ahead of the log's head means the events table was rewound
    // (e.g. TRUNCATE ... RESTART IDENTITY by a test run). Recycled ids would
    // then sit at/below the stale cursor and every fresh event would be
    // silently de-duped away. Clamp to the head: the log is the truth.
    const [head] = await this.sql<{ max: string | null }[]>`
      SELECT MAX(id)::text AS max FROM events
    `;
    const headId = BigInt(head?.max ?? 0);
    if (this.lastProcessedId > headId) {
      this.log.warn(
        { cursor: this.lastProcessedId.toString(), head: headId.toString() },
        "bus cursor is ahead of the event log (log rewound?); clamping to head",
      );
      this.lastProcessedId = headId;
      await this.sql`
        UPDATE bus_cursors SET last_processed_id = ${headId.toString()}::bigint, updated_at = now()
        WHERE consumer = ${this.consumer}
      `;
    }

    // 1) LISTEN first — buffer anything that arrives during replay. The callback
    //    is fire-and-forget, so its rejection would be an UNHANDLED one (which
    //    kills the process): everything below must settle, never throw.
    this.listen = await this.sql.listen(CHANNEL, () => {
      void this.onNotify(handler).catch((err) => {
        this.log.error({ err }, "bus notification handling failed");
      });
    });

    // 2) + 3) Replay the backlog and then keep up with live traffic — both are
    //    the same "read forward from the cursor" drain, so a notification that
    //    lands mid-replay is picked up by the same loop rather than racing it.
    await this.drain(handler);
  }

  /**
   * A notification is only a WAKE-UP SIGNAL; its payload (the event id) is
   * deliberately ignored.
   *
   * Fetching the notified row directly looks cheaper, but it loses events: two
   * NOTIFYs deliver concurrently, each did its own async read, and whichever
   * read resolved first got dispatched first. A later event landing first
   * advanced the cursor past an earlier one, which `dispatch` then discarded as
   * already-seen. Draining forward from the cursor is ordered by construction.
   */
  private async onNotify(handler: EventHandler): Promise<void> {
    await this.drain(handler);
  }

  /**
   * Deliver every committed event after the cursor, in id order, until there is
   * nothing left. Re-entrant calls set `pending` instead of running a second
   * interleaved drain, and the outer loop then goes round again — so a
   * notification arriving mid-drain is never dropped on the floor.
   */
  private async drain(handler: EventHandler): Promise<void> {
    if (this.draining) {
      this.pending = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.pending = false;
        let batch: Row[];
        do {
          // bigint is passed as text and compared via ::bigint (postgres-js's
          // typed template rejects a JS bigint parameter).
          batch = await this.sql<Row[]>`
            SELECT * FROM events
             WHERE id > ${this.lastProcessedId.toString()}::bigint
             ORDER BY id ASC
             LIMIT ${DRAIN_BATCH}
          `;
          for (const row of batch) await this.dispatch(toEvent(row), handler);
        } while (batch.length === DRAIN_BATCH);
      } while (this.pending);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Run one event through the handler and advance the cursor.
   *
   * A failing handler is LOGGED AND SKIPPED, never rethrown. Rethrowing would be
   * doubly fatal: during replay it rejects `subscribe()` (which every bot's
   * entrypoint turns into `process.exit(1)`), and on the live path it becomes an
   * unhandled rejection — and because the cursor only advances past a handled
   * event, the very same event replays on the next boot and crashes again. One
   * bad Discord call would wedge a bot in a permanent crash loop.
   *
   * So the cursor advances regardless: the bus's job is delivery, and a handler
   * that couldn't cope with an event is a handler-level problem to surface in
   * logs (and via the Ops bot's event log), not a reason to stop the world.
   */
  private async dispatch(evt: BusEvent, handler: EventHandler): Promise<void> {
    const id = BigInt(evt.dbId);
    // De-dup: replay + a buffered copy of the same event must run exactly once.
    if (id <= this.lastProcessedId) return;
    const log = withCorrelation(this.log, evt.correlationId ?? evt.eventId);
    try {
      await handler(evt);
    } catch (err) {
      log.error({ err, event: evt.type, dbId: evt.dbId }, "event handler failed; skipping event");
    }
    this.lastProcessedId = id;
    try {
      await this.sql`
        UPDATE bus_cursors SET last_processed_id = ${id.toString()}::bigint, updated_at = now()
        WHERE consumer = ${this.consumer}
      `;
    } catch (err) {
      // A cursor write is a checkpoint, not the work itself — losing one only
      // costs a re-delivery on the next boot (handlers are idempotent by design).
      log.error({ err, dbId: evt.dbId }, "failed to persist bus cursor");
    }
  }

  async close(): Promise<void> {
    if (this.listen) await this.listen.unlisten().catch(() => {});
  }
}
