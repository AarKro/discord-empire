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

function toEvent(r: Row): BusEvent {
  return {
    dbId: String(r.id),
    eventId: r.event_id,
    type: r.type,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    guildId: r.guild_id,
    actor: r.actor_kind && r.actor_id ? { kind: r.actor_kind, id: r.actor_id } : null,
    subject: r.subject_kind && r.subject_id ? { kind: r.subject_kind, id: r.subject_id } : null,
    payload: r.payload ?? {},
    correlationId: r.correlation_id,
  };
}

export class EventBus {
  private listen: { unlisten: () => Promise<void> } | null = null;
  private buffer: BusEvent[] = [];
  private draining = false;
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

    // 1) LISTEN first — buffer anything that arrives during replay.
    this.listen = await this.sql.listen(CHANNEL, (payload) => {
      void this.onNotify(payload, handler);
    });

    // 2) Replay everything committed after our cursor. bigint is passed as text
    //    and compared via ::bigint (postgres-js's typed template rejects bigint).
    const backlog = await this.sql<Row[]>`
      SELECT * FROM events WHERE id > ${this.lastProcessedId.toString()}::bigint ORDER BY id ASC
    `;
    for (const r of backlog) {
      await this.dispatch(toEvent(r), handler);
    }

    // 3) Drain the live buffer (de-dup handled in dispatch by id ordering).
    await this.drain(handler);
  }

  private async onNotify(payload: string, handler: EventHandler): Promise<void> {
    const dbId = BigInt(payload);
    const [row] = await this.sql<Row[]>`SELECT * FROM events WHERE id = ${dbId.toString()}::bigint`;
    if (!row) return;
    this.buffer.push(toEvent(row));
    await this.drain(handler);
  }

  private async drain(handler: EventHandler): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      // Process in id order; de-dup: skip anything at/under the cursor.
      this.buffer.sort((a, b) => (BigInt(a.dbId) < BigInt(b.dbId) ? -1 : 1));
      while (this.buffer.length > 0) {
        const evt = this.buffer.shift()!;
        await this.dispatch(evt, handler);
      }
    } finally {
      this.draining = false;
    }
  }

  private async dispatch(evt: BusEvent, handler: EventHandler): Promise<void> {
    const id = BigInt(evt.dbId);
    // De-dup: replay + a buffered copy of the same event must run exactly once.
    if (id <= this.lastProcessedId) return;
    const log = withCorrelation(this.log, evt.correlationId ?? evt.eventId);
    try {
      await handler(evt);
    } catch (err) {
      log.error({ err, event: evt.type, dbId: evt.dbId }, "event handler failed");
      throw err;
    }
    this.lastProcessedId = id;
    await this.sql`
      UPDATE bus_cursors SET last_processed_id = ${id.toString()}::bigint, updated_at = now()
      WHERE consumer = ${this.consumer}
    `;
  }

  async close(): Promise<void> {
    if (this.listen) await this.listen.unlisten().catch(() => {});
  }
}
