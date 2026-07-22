/**
 * Unit tests for the /build verbs the player_build workflow (§7) composes.
 * Postgres is faked (the atomic ledger is covered by the integration suite); we
 * assert the plain-data events each verb publishes and its build_queue writes,
 * keeping correlationId intact end-to-end. The workflow WIRING (which verb runs
 * in which state) is covered by workflow-runtime.integration.test.ts.
 */
import { describe, it, expect } from "vitest";
import { landCapability, scaledBuildMs } from "../src/capabilities/land.js";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";

interface World {
  blueprint: { id: string; name: string; cost_gold: number; base_ms: number } | null;
  hasPlot: boolean;
  playerExists: boolean;
  plotInserts: number;
  published: { type: string; correlationId?: string | null; payload?: Record<string, unknown> }[];
  /** the pending 'queued' row build.enqueue reads (null = none). */
  pending?: { id: string; plot_id: string; blueprint_id: string } | null;
  /** text_channel_id of the existing plot (null = provisioned-but-channelless). */
  existingChannel?: string | null;
  /** channel_id of the guild's "Land" category, or undefined = not seeded. */
  landCategoryId?: string | null;
  /** true = gateway.createPlotChannels reports a permission failure (returns null). */
  provisionFails?: boolean;
  plotChannelCalls?: number;
  channelUpdates?: number;
  /** row the guarded build_queue completion UPDATE returns (null = already done). */
  completeRow?: { owner_id: string; blueprint_id: string } | null;
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM blueprint_catalog")) return Promise.resolve(world.blueprint ? [world.blueprint] : []);
    if (q.includes("FROM locations"))
      return Promise.resolve(world.landCategoryId ? [{ channel_id: world.landCategoryId }] : []);
    if (q.includes("FROM land_plots"))
      return Promise.resolve(world.hasPlot ? [{ id: "plot1", text_channel_id: world.existingChannel ?? null }] : []);
    if (q.includes("INSERT INTO land_plots")) {
      world.plotInserts += 1;
      world.hasPlot = true; // the starter plot now exists
      return Promise.resolve([]);
    }
    if (q.includes("UPDATE land_plots")) {
      world.channelUpdates = (world.channelUpdates ?? 0) + 1;
      return Promise.resolve([]);
    }
    if (q.includes("SELECT tier FROM players")) return Promise.resolve([{ tier: 1 }]);
    if (q.includes("build_queue")) {
      if (q.includes("SELECT id, plot_id, blueprint_id")) return Promise.resolve(world.pending ? [world.pending] : []);
      if (q.includes("SET status = 'completed'"))
        return Promise.resolve(world.completeRow === undefined ? [{ owner_id: "u1", blueprint_id: "farm" }] : world.completeRow ? [world.completeRow] : []);
      return Promise.resolve([]); // INSERT 'queued' / UPDATE 'building' / DELETE
    }
    return Promise.resolve([]);
  };
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    // ensurePlayer's tx: report the player already exists unless told otherwise.
    const tx = (strings: TemplateStringsArray): Promise<unknown[]> => {
      const q = strings.join("?");
      if (q.includes("INSERT INTO players")) return Promise.resolve(world.playerExists ? [] : [{ discord_user_id: "u1" }]);
      return Promise.resolve([]);
    };
    return fn(tx);
  };
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log };
  return {
    bot: "builder",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: World["published"][number]) => {
        world.published.push(input);
        return input as never;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: {
      createPlotChannels: async () => {
        world.plotChannelCalls = (world.plotChannelCalls ?? 0) + 1;
        return world.provisionFails ? null : { textId: "t1", voiceId: "v1" };
      },
    } as unknown as CapabilityContext["gateway"],
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
    subject: { kind: "npc", id: "builder" },
    payload: {},
    correlationId: "cmd_1",
    ...over,
  };
}

const farm = { id: "farm", name: "Wheat Farm", cost_gold: 50, base_ms: 300_000 };

/** Convenience: invoke a land verb by name. */
function verb(cap: ReturnType<typeof landCapability>, name: string, args: Record<string, unknown>, e: BusEvent, ctx: CapabilityContext) {
  return cap.actions[name]!(args, e, ctx);
}

describe("scaledBuildMs (§2.5 hybrid pacing)", () => {
  it("is base at tier 1 and scales up with tier", () => {
    expect(scaledBuildMs(300_000, 1)).toBe(300_000);
    expect(scaledBuildMs(300_000, 3)).toBe(600_000);
  });
});

describe("build.request — guards → stake → charge (§10 Builder)", () => {
  const base = (over: Partial<World>): World => ({ blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [], ...over });

  it("rejects an unknown blueprint and throws (correlationId preserved)", async () => {
    const world = base({ blueprint: null });
    const ctx = makeCtx(world);
    await expect(verb(landCapability(), "build.request", {}, evt({ type: "build.requested", payload: { blueprint: "nope" } }), ctx)).rejects.toThrow();
    const rej = world.published.find((e) => e.type === "build.rejected");
    expect(rej?.correlationId).toBe("cmd_1");
    expect(world.published.find((e) => e.type === "trade.request")).toBeUndefined();
  });

  it("publishes a trade.request (cost via trade) when guards pass — no build.queued yet", async () => {
    const world = base({});
    await verb(landCapability(), "build.request", {}, evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));
    const req = world.published.find((e) => e.type === "trade.request");
    expect(req?.payload).toMatchObject({ item: "build_permit", qty: 1, price: 50 });
    expect(req?.correlationId).toBe("cmd_1"); // same id resolves the reply
    expect(world.published.find((e) => e.type === "build.queued")).toBeUndefined();
  });

  it("auto-provisions a starter plot on first /build then charges", async () => {
    const world = base({ hasPlot: false });
    await verb(landCapability(), "build.request", {}, evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));
    expect(world.plotInserts).toBe(1);
    expect(world.published.find((e) => e.type === "trade.request")).toBeDefined();
  });

  it("does not re-provision a plot the player already has", async () => {
    const world = base({});
    await verb(landCapability(), "build.request", {}, evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));
    expect(world.plotInserts).toBe(0);
  });

  it("allows concurrent builds — a second request also charges (no serialize block)", async () => {
    const world = base({});
    const ctx = makeCtx(world);
    await verb(landCapability(), "build.request", {}, evt({ type: "build.requested", payload: { blueprint: "farm" }, correlationId: "cmd_A" }), ctx);
    await verb(landCapability(), "build.request", {}, evt({ type: "build.requested", payload: { blueprint: "farm" }, correlationId: "cmd_B" }), ctx);
    const charges = world.published.filter((e) => e.type === "trade.request").map((e) => e.correlationId);
    expect(charges).toEqual(["cmd_A", "cmd_B"]); // both proceed, each on its own correlation
    expect(world.published.find((e) => e.type === "build.rejected")).toBeUndefined();
  });
});

describe("land plot channel provisioning (§2.4)", () => {
  const build = (world: World) =>
    verb(landCapability(), "build.request", {}, evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));

  it("creates text+voice channels under the Land category and stores their ids", async () => {
    const world: World = { blueprint: farm, hasPlot: false, playerExists: true, plotInserts: 0, published: [], landCategoryId: "cat1" };
    await build(world);
    expect(world.plotInserts).toBe(1);
    expect(world.plotChannelCalls).toBe(1);
    expect(world.channelUpdates).toBe(1); // ids persisted to land_plots
  });

  it("leaves the plot DB-only (no channel call) when no Land category is seeded", async () => {
    const world: World = { blueprint: farm, hasPlot: false, playerExists: true, plotInserts: 0, published: [] };
    await build(world);
    expect(world.plotChannelCalls).toBeUndefined();
    expect(world.channelUpdates).toBeUndefined();
    expect(world.published.find((e) => e.type === "trade.request")).toBeDefined(); // never blocks the build
  });

  it("back-fills channels for an existing plot that has none", async () => {
    const world: World = { blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [], existingChannel: null, landCategoryId: "cat1" };
    await build(world);
    expect(world.plotInserts).toBe(0); // not re-staked
    expect(world.plotChannelCalls).toBe(1);
    expect(world.channelUpdates).toBe(1);
  });

  it("does not touch channels when the plot already has one", async () => {
    const world: World = { blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [], existingChannel: "chan1", landCategoryId: "cat1" };
    await build(world);
    expect(world.plotChannelCalls).toBeUndefined();
    expect(world.channelUpdates).toBeUndefined();
  });

  it("skips the id write when provisioning fails (missing Manage Channels)", async () => {
    const world: World = { blueprint: farm, hasPlot: false, playerExists: true, plotInserts: 0, published: [], landCategoryId: "cat1", provisionFails: true };
    await build(world);
    expect(world.plotChannelCalls).toBe(1);
    expect(world.channelUpdates).toBeUndefined(); // no ids to store
    expect(world.published.find((e) => e.type === "trade.request")).toBeDefined();
  });
});

describe("build.enqueue — charge settled → timed build (§5.12)", () => {
  it("promotes the queued row and announces build.queued (correlationId preserved)", async () => {
    const world: World = { blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [], pending: { id: "q1", plot_id: "plot1", blueprint_id: "farm" } };
    await verb(landCapability(), "build.enqueue", {}, evt({ type: "trade.completed" }), makeCtx(world));
    const queued = world.published.find((e) => e.type === "build.queued");
    expect(queued?.correlationId).toBe("cmd_1");
    expect(queued?.payload?.blueprint).toBe("farm");
    expect(String(queued?.payload?.message)).toContain("Foundation laid");
  });

  it("no-ops when there is no queued build for the player", async () => {
    const world: World = { blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [], pending: null };
    await verb(landCapability(), "build.enqueue", {}, evt({ type: "trade.completed" }), makeCtx(world));
    expect(world.published.find((e) => e.type === "build.queued")).toBeUndefined();
  });
});

describe("build.complete — completion → notify (§5.9, exactly-once)", () => {
  it("flips the queue row and asks notify to ping the owner", async () => {
    const world: World = { blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [], completeRow: { owner_id: "u1", blueprint_id: "farm" } };
    await verb(landCapability(), "build.complete", {}, evt({ type: "build.completed", payload: { queue_id: "q1" } }), makeCtx(world));
    const n = world.published.find((e) => e.type === "notify.requested");
    expect(n).toBeDefined();
    expect(String(n?.payload?.message)).toContain("farm");
  });

  it("no-ops (no notify) when the completion transition already happened", async () => {
    const world: World = { blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [], completeRow: null };
    await verb(landCapability(), "build.complete", {}, evt({ type: "build.completed", payload: { queue_id: "q1" } }), makeCtx(world));
    expect(world.published.find((e) => e.type === "notify.requested")).toBeUndefined();
  });
});

describe("build.reject — charge failed → clean up + reply", () => {
  it("publishes build.rejected with the given message (correlationId preserved)", async () => {
    const world: World = { blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [] };
    await verb(landCapability(), "build.reject", { message: "You can't cover the cost of that just yet." }, evt({ type: "trade.failed" }), makeCtx(world));
    const rej = world.published.find((e) => e.type === "build.rejected");
    expect(rej?.correlationId).toBe("cmd_1");
    expect(String(rej?.payload?.message)).toContain("cover the cost");
  });
});
