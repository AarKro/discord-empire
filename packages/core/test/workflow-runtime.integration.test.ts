/**
 * Integration suite for the embedded WorkflowRuntime (§7) against a REAL Postgres
 * (it persists instances / arms timers, so the I/O half can't be unit-faked like
 * the pure engine). Mirrors the ledger suite: opt-in on TEST_DATABASE_URL.
 *
 *   pnpm test:integration            # after `docker compose up -d postgres`
 *
 * Proves the embedded path: a trigger event creates a scoped instance and
 * dispatches its actions through the bot's capability registry; a re-delivered
 * trigger (bus replay on reboot) is de-duped by the singleton guard; an event
 * transition advances the instance to a final state.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "@empire/db";
import { parseContent, Workflow } from "@empire/content-schemas";
import { WorkflowRuntime } from "../src/workflow/runtime.js";
import { EventBus, type BusEvent } from "../src/bus.js";
import { CapabilityRegistry, type Capability, type CapabilityContext } from "../src/capability.js";
import { rootLogger } from "../src/logger.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const wander = parseContent(
  Workflow,
  `
id: test_wander
trigger: { event: bot.ready }
scope: npc
context: { npc: merchant }
initial: at_bazaar
states:
  at_bazaar:
    actions: [{ spy_move: { stop: bazaar } }]
    on: { go.square: at_square }
  at_square:
    actions: [{ spy_move: { stop: square } }]
    final: true
`,
  "test_wander.yaml",
);

/** A bus event as the runtime consumes it (onEvent takes a BusEvent directly). */
function evt(type: string, subjectId = "merchant"): BusEvent {
  return {
    dbId: "0", eventId: `e_${type}`, type, ts: "", guildId: null,
    actor: null, subject: { kind: "npc", id: subjectId }, payload: {}, correlationId: null,
  };
}

let h: DbHandle;

suite("embedded workflow runtime (§7)", () => {
  let moves: { stop: unknown }[];
  let runtime: WorkflowRuntime;

  beforeAll(async () => {
    h = openDb(url!, { max: 4 });
    await ensureSchema(h);
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.sql`TRUNCATE workflow_instances, events RESTART IDENTITY CASCADE`;
    moves = [];
    const spy: Capability = {
      name: "spy",
      consumes: [],
      actions: { spy_move: (args) => { moves.push({ stop: args.stop }); } },
    };
    const registry = new CapabilityRegistry();
    registry.register(spy);
    const bus = new EventBus(h.sql, "test-runtime", rootLogger);
    const makeContext = (correlationId: string): CapabilityContext => ({
      bot: "merchant", sql: h.sql, bus,
      gateway: {} as unknown as CapabilityContext["gateway"],
      personas: {} as unknown as CapabilityContext["personas"],
      logger: rootLogger.child({ correlation_id: correlationId }), config: {},
    });
    runtime = new WorkflowRuntime([wander], { sql: h.sql, bus, registry, logger: rootLogger, makeContext });
  });

  it("a trigger creates a scoped instance and dispatches its actions through the registry", async () => {
    await runtime.onEvent(evt("bot.ready"));

    const rows = await h.sql`SELECT workflow_id, scope, scope_key, state, status FROM workflow_instances`;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ workflow_id: "test_wander", scope: "npc", scope_key: "merchant", state: "at_bazaar", status: "active" });
    expect(moves).toEqual([{ stop: "bazaar" }]);
  });

  it("de-dupes a re-delivered trigger (singleton per workflow+scope)", async () => {
    await runtime.onEvent(evt("bot.ready"));
    await runtime.onEvent(evt("bot.ready")); // replay on reboot

    const [{ n }] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM workflow_instances`;
    expect(n).toBe(1);
    expect(moves).toEqual([{ stop: "bazaar" }]); // second trigger ran no actions
  });

  it("advances the instance to a final state on an event transition", async () => {
    await runtime.onEvent(evt("bot.ready"));
    await runtime.onEvent(evt("go.square"));

    const [row] = await h.sql`SELECT state, status FROM workflow_instances`;
    expect(row).toMatchObject({ state: "at_square", status: "final" });
    expect(moves).toEqual([{ stop: "bazaar" }, { stop: "square" }]);
  });
});

/** Create only the tables this suite exercises, if migrations haven't run. */
async function ensureSchema(handle: DbHandle) {
  const { sql } = handle;
  await sql`CREATE TABLE IF NOT EXISTS events (
    id bigserial PRIMARY KEY,
    event_id text NOT NULL,
    type text NOT NULL,
    ts timestamptz NOT NULL DEFAULT now(),
    guild_id text,
    actor_kind text, actor_id text,
    subject_kind text, subject_id text,
    payload jsonb NOT NULL DEFAULT '{}',
    correlation_id text
  )`;
  await sql`CREATE TABLE IF NOT EXISTS workflow_instances (
    id text PRIMARY KEY,
    workflow_id text NOT NULL,
    scope text NOT NULL,
    scope_key text NOT NULL,
    state text NOT NULL,
    context jsonb NOT NULL DEFAULT '{}',
    correlation_id text,
    timer_at timestamptz,
    status text NOT NULL DEFAULT 'active',
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
}
