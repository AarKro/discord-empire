/**
 * Integration suite for the embedded WorkflowRuntime (§7) against a REAL Postgres
 * (it persists instances / arms timers, so the I/O half can't be unit-faked like
 * the pure engine). Mirrors the ledger suite: opt-in on TEST_DATABASE_URL.
 *
 *   pnpm test:integration            # after `docker compose up -d postgres`
 *
 * Proves the embedded path: a trigger event creates a scoped instance and
 * dispatches its actions through the bot's capability registry; a re-delivered
 * trigger (bus replay on reboot) is de-duped by a singleton workflow; event
 * transitions advance the instance to a final state. A second suite drives the
 * SHIPPED player_build workflow through its charge/complete + rejection paths
 * (verbs stubbed) to prove the state machine's wiring.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDb, ensurePlayer, type DbHandle } from "@empire/db";
import { parseContent, loadContentFile, Workflow } from "@empire/content-schemas";
import { WorkflowRuntime } from "../src/workflow/runtime.js";
import { EventBus, type BusEvent } from "../src/bus.js";
import { CapabilityRegistry, type Capability, type CapabilityContext, type ActionHandler } from "../src/capability.js";
import { rootLogger } from "../src/logger.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const CONTENT = join(dirname(fileURLToPath(import.meta.url)), "../../../content");

const wander = parseContent(
  Workflow,
  `
id: test_wander
trigger: { event: bot.ready }
scope: npc
singleton: true
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
function npcEvt(type: string, subjectId = "merchant"): BusEvent {
  return {
    dbId: "0", eventId: `e_${type}`, type, ts: "", guildId: null,
    actor: null, subject: { kind: "npc", id: subjectId }, payload: {}, correlationId: null,
  };
}

/** A player-actored event (build.requested / trade.* / build.completed shape). */
function playerEvt(type: string, playerId: string, correlationId: string | null = null, payload: Record<string, unknown> = {}): BusEvent {
  return {
    dbId: "0", eventId: `e_${type}`, type, ts: "", guildId: null,
    actor: { kind: "player", id: playerId }, subject: { kind: "npc", id: "builder" }, payload, correlationId,
  };
}

let h: DbHandle;

function makeRuntime(workflows: Workflow[], actions: Record<string, ActionHandler>): WorkflowRuntime {
  const cap: Capability = { name: "spy", consumes: [], actions };
  const registry = new CapabilityRegistry();
  registry.register(cap);
  const bus = new EventBus(h.sql, "test-runtime", rootLogger);
  const makeContext = (correlationId: string): CapabilityContext => ({
    bot: "builder", sql: h.sql, bus,
    gateway: {} as unknown as CapabilityContext["gateway"],
    personas: {} as unknown as CapabilityContext["personas"],
    logger: rootLogger.child({ correlation_id: correlationId }), config: {},
  });
  return new WorkflowRuntime(workflows, { sql: h.sql, bus, registry, logger: rootLogger, makeContext });
}

suite("embedded workflow runtime (§7)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 4 });
    await ensureSchema(h);
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.sql`TRUNCATE workflow_instances, events, balances, players, reputation RESTART IDENTITY CASCADE`;
  });

  describe("singleton npc loop (test_wander)", () => {
    let moves: { stop: unknown }[];
    let runtime: WorkflowRuntime;

    beforeEach(() => {
      moves = [];
      runtime = makeRuntime([wander], { spy_move: (args) => { moves.push({ stop: args.stop }); } });
    });

    it("a trigger creates a scoped instance and dispatches its actions through the registry", async () => {
      await runtime.onEvent(npcEvt("bot.ready"));

      const rows = await h.sql`SELECT workflow_id, scope, scope_key, state, status FROM workflow_instances`;
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ workflow_id: "test_wander", scope: "npc", scope_key: "merchant", state: "at_bazaar", status: "active" });
      expect(moves).toEqual([{ stop: "bazaar" }]);
    });

    it("de-dupes a re-delivered trigger (singleton per workflow+scope)", async () => {
      await runtime.onEvent(npcEvt("bot.ready"));
      await runtime.onEvent(npcEvt("bot.ready")); // replay on reboot

      const [{ n }] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM workflow_instances`;
      expect(n).toBe(1);
      expect(moves).toEqual([{ stop: "bazaar" }]); // second trigger ran no actions
    });

    it("advances the instance to a final state on an event transition", async () => {
      await runtime.onEvent(npcEvt("bot.ready"));
      await runtime.onEvent(npcEvt("go.square"));

      const [row] = await h.sql`SELECT state, status FROM workflow_instances`;
      expect(row).toMatchObject({ state: "at_square", status: "final" });
      expect(moves).toEqual([{ stop: "bazaar" }, { stop: "square" }]);
    });
  });

  describe("player_build (the shipped /build workflow)", () => {
    const buildWf = loadContentFile(Workflow, join(CONTENT, "workflows/player_build.yaml"));
    let calls: string[];
    let runtime: WorkflowRuntime;

    beforeEach(() => {
      calls = [];
      const record = (verb: string): ActionHandler => () => { calls.push(verb); };
      runtime = makeRuntime([buildWf], {
        "build.request": record("build.request"),
        "build.enqueue": record("build.enqueue"),
        "build.complete": record("build.complete"),
        "build.reject": record("build.reject"),
      });
    });

    it("charge → complete: requested → charging → building → done, one verb per state", async () => {
      await runtime.onEvent(playerEvt("build.requested", "p1", "c1", { blueprint: "farm" }));
      let [row] = await h.sql`SELECT scope, scope_key, state, status FROM workflow_instances`;
      expect(row).toMatchObject({ scope: "player", scope_key: "p1", state: "charging", status: "active" });

      await runtime.onEvent(playerEvt("trade.completed", "p1", "c1"));
      [row] = await h.sql`SELECT state, status FROM workflow_instances`;
      expect(row).toMatchObject({ state: "building", status: "active" });

      await runtime.onEvent(playerEvt("build.completed", "p1", null, { queue_id: "q1" }));
      [row] = await h.sql`SELECT state, status FROM workflow_instances`;
      expect(row).toMatchObject({ state: "done", status: "final" });

      expect(calls).toEqual(["build.request", "build.enqueue", "build.complete"]);
    });

    it("insufficient funds: trade.failed routes charging → rejected (final)", async () => {
      await runtime.onEvent(playerEvt("build.requested", "p2", "c2", { blueprint: "farm" }));
      await runtime.onEvent(playerEvt("trade.failed", "p2", "c2"));

      const [row] = await h.sql`SELECT state, status FROM workflow_instances WHERE scope_key = 'p2'`;
      expect(row).toMatchObject({ state: "rejected", status: "final" });
      expect(calls).toEqual(["build.request", "build.reject"]);
    });

    it("pre-charge failure: a throwing build.request aborts via on_error to rejected_pre (final)", async () => {
      const rt = makeRuntime([buildWf], {
        "build.request": () => { throw new Error("already building"); },
        "build.enqueue": () => {},
        "build.complete": () => {},
        "build.reject": () => {},
      });
      await rt.onEvent(playerEvt("build.requested", "p3", "c3", { blueprint: "farm" }));

      const [row] = await h.sql`SELECT state, status FROM workflow_instances WHERE scope_key = 'p3'`;
      expect(row).toMatchObject({ state: "rejected_pre", status: "final" });
    });

    it("is not a singleton: two players build independently", async () => {
      await runtime.onEvent(playerEvt("build.requested", "a", "ca", { blueprint: "farm" }));
      await runtime.onEvent(playerEvt("build.requested", "b", "cb", { blueprint: "farm" }));

      const [{ n }] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM workflow_instances WHERE workflow_id = 'player_build'`;
      expect(n).toBe(2);
    });
  });

  describe("dialogue-as-workflow (prompt/options → render + emit)", () => {
    const haggle = parseContent(
      Workflow,
      `
id: haggle
scope: player
singleton: true
trigger: { event: stall.entered }
initial: greet
states:
  greet:
    prompt: "Care to see the blueprint?"
    options:
      - { id: browse, label: "Show me", goto: offer }
      - { id: leave, label: "Not today", goto: farewell }
  offer:
    prompt: "120 gold."
    options:
      - { id: buy, label: "Buy (120g)", guard: { expr: "player.gold >= 120" }, goto: sold,
          emit: [{ type: trade.request, payload: { item: forge, price: 120 } }] }
      - { id: walk, label: "Too steep", goto: farewell }
  sold: { prompt: "A pleasure.", final: true }
  farewell: { prompt: "Safe travels.", final: true }
`,
      "haggle.yaml",
    );
    let runtime: WorkflowRuntime;

    beforeEach(() => {
      runtime = makeRuntime([haggle], {}); // dialogue drives via render/emit, no verbs
    });

    const seedPlayer = (id: string, gold: number) => ensurePlayer(h.sql, id, "g1", gold);
    const evtsOf = (type: string) => h.sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE type = ${type} ORDER BY id`;

    it("renders the opening prompt with guard-filtered option buttons on trigger", async () => {
      await seedPlayer("rich", 500);
      await runtime.onEvent(playerEvt("stall.entered", "rich"));

      const [inst] = await h.sql`SELECT state, status FROM workflow_instances WHERE workflow_id = 'haggle'`;
      expect(inst).toMatchObject({ state: "greet", status: "active" });
      const [opened] = await evtsOf("dialogue.opened");
      expect(opened!.payload.text).toBe("Care to see the blueprint?");
      expect((opened!.payload.options as { id: string }[]).map((o) => o.id)).toEqual(["dlg:browse", "dlg:leave"]);
    });

    it("advances on an option click, emits the option's events, and closes at a final node", async () => {
      await seedPlayer("rich", 500);
      await runtime.onEvent(playerEvt("stall.entered", "rich"));
      await runtime.onEvent(playerEvt("dialogue.choose", "rich", null, { option: "browse" }));

      const [node] = await evtsOf("dialogue.node");
      expect(node!.payload.node).toBe("offer");
      // gold 500 ≥ 120 → the guarded "buy" button is offered.
      expect((node!.payload.options as { id: string }[]).map((o) => o.id)).toEqual(["dlg:buy", "dlg:walk"]);

      await runtime.onEvent(playerEvt("dialogue.choose", "rich", null, { option: "buy" }));
      const [req] = await evtsOf("trade.request");
      expect(req!.payload).toMatchObject({ item: "forge", price: 120 });
      const [closed] = await evtsOf("dialogue.closed");
      expect(closed!.payload.node).toBe("sold");
      const [inst] = await h.sql`SELECT state, status FROM workflow_instances WHERE workflow_id = 'haggle'`;
      expect(inst).toMatchObject({ state: "sold", status: "final" });
    });

    it("hides a guarded option below its threshold and refuses the click", async () => {
      await seedPlayer("poor", 10);
      await runtime.onEvent(playerEvt("stall.entered", "poor"));
      await runtime.onEvent(playerEvt("dialogue.choose", "poor", null, { option: "browse" }));

      const [node] = await evtsOf("dialogue.node");
      expect((node!.payload.options as { id: string }[]).map((o) => o.id)).toEqual(["dlg:walk"]); // no buy

      await runtime.onEvent(playerEvt("dialogue.choose", "poor", null, { option: "buy" }));
      expect((await evtsOf("trade.request")).length).toBe(0); // guard refused it
      const [inst] = await h.sql`SELECT state FROM workflow_instances WHERE workflow_id = 'haggle'`;
      expect(inst!.state).toBe("offer"); // stayed put
    });
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
  // Guard-scope reads (loadGuardScope) for player-scoped dialogue workflows.
  await sql`CREATE TABLE IF NOT EXISTS balances (
    owner_kind text NOT NULL, owner_id text NOT NULL,
    currency text NOT NULL DEFAULT 'gold', amount bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_kind, owner_id, currency)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS players (
    discord_user_id text PRIMARY KEY,
    flags jsonb NOT NULL DEFAULT '{}', position_district_id text,
    tier int NOT NULL DEFAULT 1
  )`;
  await sql`CREATE TABLE IF NOT EXISTS reputation (
    player_id text NOT NULL, npc_id text NOT NULL, score int NOT NULL DEFAULT 0,
    PRIMARY KEY (player_id, npc_id)
  )`;
}
