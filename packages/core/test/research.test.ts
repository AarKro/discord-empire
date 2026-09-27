/**
 * Unit tests for the /research verbs the architect_research workflow (§7) composes.
 * Postgres is faked (the atomic ledger is covered by the integration suite); we
 * assert the plain-data events each verb publishes and its research writes, keeping
 * correlationId intact end-to-end. Mirrors land.test.ts — research is a structural
 * clone of the build queue.
 */
import { describe, it, expect } from "vitest";
import { researchCapability, scaledResearchMs } from "../src/capabilities/research.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";

interface Node {
  id: string;
  name: string;
  cost_gold: number;
  base_ms: number;
  prereqs: string[];
  grants_blueprints: string[];
}

interface World {
  node: Node | null;
  playerExists: boolean;
  /** status of the player's existing row for the requested node (undefined = none). */
  existingStatus?: string;
  /** node ids the player has completed (the prereq set). */
  done: string[];
  /** the pending row research.enqueue reads (null = none). */
  pending?: { research_id: string } | null;
  /** row the guarded completion UPDATE returns (null = already done). */
  completeRow?: { research_id: string } | null;
  blueprintGrants: number;
  published: { type: string; correlationId?: string | null; payload?: Record<string, unknown> }[];
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM research_catalog")) return Promise.resolve(world.node ? [world.node] : []);
    if (q.includes("SELECT status FROM research"))
      return Promise.resolve(world.existingStatus ? [{ status: world.existingStatus }] : []);
    if (q.includes("SELECT research_id FROM research") && q.includes("status = 'done'"))
      return Promise.resolve(world.done.map((id) => ({ research_id: id })));
    if (q.includes("SELECT research_id FROM research") && q.includes("completes_at IS NULL"))
      return Promise.resolve(world.pending ? [world.pending] : []);
    if (q.includes("UPDATE research SET status = 'done'"))
      return Promise.resolve(
        world.completeRow === undefined ? [{ research_id: "trade_routes" }] : world.completeRow ? [world.completeRow] : [],
      );
    if (q.includes("INSERT INTO blueprints")) {
      world.blueprintGrants += 1;
      return Promise.resolve([]);
    }
    if (q.includes("SELECT tier FROM players")) return Promise.resolve([{ tier: 1 }]);
    // INSERT INTO research (upsert) / UPDATE research SET completes_at / DELETE FROM research
    return Promise.resolve([]);
  };
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = (strings: TemplateStringsArray): Promise<unknown[]> => {
      const q = strings.join("?");
      if (q.includes("INSERT INTO players")) return Promise.resolve(world.playerExists ? [] : [{ discord_user_id: "u1" }]);
      return Promise.resolve([]);
    };
    return fn(tx);
  };
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log };
  return {
    bot: "architect",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: World["published"][number]) => {
        world.published.push(input);
        return input as never;
      },
    } as unknown as CapabilityContext["bus"],
    personas: {
      guildIds: ["g1"],
      homeGuild: (g?: string | null) => g ?? "g1",
    } as unknown as CapabilityContext["personas"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

function evt(over: Partial<BusEvent> & { type: string }): BusEvent {
  return {
    dbId: "1",
    eventId: "e1",
    ts: "",
    guildId: "g1",
    actor: { kind: "player", id: "u1" },
    subject: { kind: "npc", id: "architect" },
    payload: {},
    correlationId: "cmd_1",
    ...over,
  };
}

const tradeRoutes: Node = { id: "trade_routes", name: "Trade Routes", cost_gold: 60, base_ms: 300_000, prereqs: [], grants_blueprints: ["trade_post"] };

function verb(cap: ReturnType<typeof researchCapability>, name: string, args: Record<string, unknown>, e: BusEvent, ctx: CapabilityContext) {
  return cap.actions[name]!(args, e, ctx);
}

describe("scaledResearchMs (§2.5 hybrid pacing)", () => {
  it("is base at tier 1 and scales up with tier", () => {
    expect(scaledResearchMs(300_000, 1)).toBe(300_000);
    expect(scaledResearchMs(300_000, 3)).toBe(600_000);
  });
});

describe("research.request — guards → charge (§4 Architect)", () => {
  const base = (over: Partial<World>): World => ({ node: tradeRoutes, playerExists: true, done: [], blueprintGrants: 0, published: [], ...over });

  it("rejects an unknown node and throws (correlationId preserved)", async () => {
    const world = base({ node: null });
    await expect(
      verb(researchCapability(), "research.request", {}, evt({ type: "research.requested", payload: { node: "nope" } }), makeCtx(world)),
    ).rejects.toThrow();
    expect(world.published.find((e) => e.type === "research.rejected")?.correlationId).toBe("cmd_1");
    expect(world.published.find((e) => e.type === "trade.request")).toBeUndefined();
  });

  it("rejects when a prerequisite is not yet done and throws", async () => {
    const world = base({ node: { ...tradeRoutes, id: "harbor_charter", name: "Harbor Charter", prereqs: ["trade_routes"] }, done: [] });
    await expect(
      verb(researchCapability(), "research.request", {}, evt({ type: "research.requested", payload: { node: "harbor_charter" } }), makeCtx(world)),
    ).rejects.toThrow();
    const rej = world.published.find((e) => e.type === "research.rejected");
    expect(String(rej?.payload?.message)).toContain("trade_routes");
    expect(world.published.find((e) => e.type === "trade.request")).toBeUndefined();
  });

  it("rejects a node already completed and throws", async () => {
    const world = base({ existingStatus: "done" });
    await expect(
      verb(researchCapability(), "research.request", {}, evt({ type: "research.requested", payload: { node: "trade_routes" } }), makeCtx(world)),
    ).rejects.toThrow();
    expect(world.published.find((e) => e.type === "trade.request")).toBeUndefined();
  });

  it("charges via trade when guards pass (prereqs met) — no research.queued yet", async () => {
    const world = base({ node: { ...tradeRoutes, id: "harbor_charter", prereqs: ["trade_routes"] }, done: ["trade_routes"] });
    await verb(researchCapability(), "research.request", {}, evt({ type: "research.requested", payload: { node: "harbor_charter" } }), makeCtx(world));
    const req = world.published.find((e) => e.type === "trade.request");
    expect(req?.payload).toMatchObject({ item: "research_permit", qty: 1 });
    expect(req?.correlationId).toBe("cmd_1");
    expect(world.published.find((e) => e.type === "research.queued")).toBeUndefined();
  });

  it("allows concurrent research on different nodes — each charges on its own correlation", async () => {
    const world = base({});
    const ctx = makeCtx(world);
    await verb(researchCapability(), "research.request", {}, evt({ type: "research.requested", payload: { node: "trade_routes" }, correlationId: "cmd_A" }), ctx);
    await verb(researchCapability(), "research.request", {}, evt({ type: "research.requested", payload: { node: "trade_routes" }, correlationId: "cmd_B" }), ctx);
    const charges = world.published.filter((e) => e.type === "trade.request").map((e) => e.correlationId);
    expect(charges).toEqual(["cmd_A", "cmd_B"]);
  });
});

describe("research.enqueue — charge settled → timed node", () => {
  it("times the pending row and announces research.queued (correlationId preserved)", async () => {
    const world: World = { node: tradeRoutes, playerExists: true, done: [], blueprintGrants: 0, published: [], pending: { research_id: "trade_routes" } };
    await verb(researchCapability(), "research.enqueue", {}, evt({ type: "trade.completed" }), makeCtx(world));
    const queued = world.published.find((e) => e.type === "research.queued");
    expect(queued?.correlationId).toBe("cmd_1");
    expect(queued?.payload?.node).toBe("trade_routes");
    expect(String(queued?.payload?.message)).toContain("Research begun");
  });

  it("no-ops when there is no pending node for the charge", async () => {
    const world: World = { node: tradeRoutes, playerExists: true, done: [], blueprintGrants: 0, published: [], pending: null };
    await verb(researchCapability(), "research.enqueue", {}, evt({ type: "trade.completed" }), makeCtx(world));
    expect(world.published.find((e) => e.type === "research.queued")).toBeUndefined();
  });
});

describe("research.complete — completion → grant + notify (exactly-once)", () => {
  it("flips the row, grants the node's blueprints, and pings the owner", async () => {
    const world: World = { node: tradeRoutes, playerExists: true, done: [], blueprintGrants: 0, published: [], completeRow: { research_id: "trade_routes" } };
    await verb(researchCapability(), "research.complete", {}, evt({ type: "research.completed", payload: { node: "trade_routes" } }), makeCtx(world));
    expect(world.blueprintGrants).toBe(1); // trade_post granted
    const n = world.published.find((e) => e.type === "notify.requested");
    expect(String(n?.payload?.message)).toContain("Trade Routes");
    // …and records the milestone progression counts (§2.5 tiers).
    expect(world.published.find((e) => e.type === "research.finished")?.payload).toMatchObject({ node: "trade_routes" });
  });

  it("no-ops (no grant, no notify) when the completion already happened", async () => {
    const world: World = { node: tradeRoutes, playerExists: true, done: [], blueprintGrants: 0, published: [], completeRow: null };
    await verb(researchCapability(), "research.complete", {}, evt({ type: "research.completed", payload: { node: "trade_routes" } }), makeCtx(world));
    expect(world.blueprintGrants).toBe(0);
    expect(world.published.find((e) => e.type === "notify.requested")).toBeUndefined();
    expect(world.published.find((e) => e.type === "research.finished")).toBeUndefined();
  });
});

describe("research.reject — charge failed → clean up + reply", () => {
  it("publishes research.rejected with the given message (correlationId preserved)", async () => {
    const world: World = { node: tradeRoutes, playerExists: true, done: [], blueprintGrants: 0, published: [] };
    await verb(researchCapability(), "research.reject", { message: "You can't cover the cost of that study just yet." }, evt({ type: "trade.failed" }), makeCtx(world));
    const rej = world.published.find((e) => e.type === "research.rejected");
    expect(rej?.correlationId).toBe("cmd_1");
    expect(String(rej?.payload?.message)).toContain("cover the cost");
  });
});
