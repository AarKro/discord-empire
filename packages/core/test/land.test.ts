/**
 * Unit tests for the /build flow's deterministic core (§10 Builder): the
 * guard→trade→enqueue handshake. Postgres is faked (the atomic ledger is
 * covered by the integration suite); we assert the plain-data events land
 * publishes, keeping correlationId intact end-to-end.
 */
import { describe, it, expect } from "vitest";
import { landCapability, scaledBuildMs } from "../src/capabilities/land.js";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";

interface World {
  gold: number;
  blueprint: { id: string; name: string; cost_gold: number; base_ms: number } | null;
  hasPlot: boolean;
  playerExists: boolean;
  plotInserts: number;
  published: { type: string; correlationId?: string; payload?: Record<string, unknown> }[];
  /** text_channel_id of the existing plot (null = provisioned-but-channelless). */
  existingChannel?: string | null;
  /** channel_id of the guild's "Land" category, or undefined = not seeded. */
  landCategoryId?: string | null;
  /** true = gateway.createPlotChannels reports a permission failure (returns null). */
  provisionFails?: boolean;
  /** spies for the provisioning path. */
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
    if (q.includes("FROM balances")) return Promise.resolve([{ amount: world.gold }]);
    if (q.includes("SELECT tier FROM players")) return Promise.resolve([{ tier: 1 }]);
    if (q.includes("INSERT INTO build_queue")) return Promise.resolve([{ id: "q1" }]);
    if (q.includes("UPDATE build_queue"))
      return Promise.resolve(world.completeRow === undefined ? [{ owner_id: "u1", blueprint_id: "farm" }] : world.completeRow ? [world.completeRow] : []);
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

describe("scaledBuildMs (§2.5 hybrid pacing)", () => {
  it("is base at tier 1 and scales up with tier", () => {
    expect(scaledBuildMs(300_000, 1)).toBe(300_000);
    expect(scaledBuildMs(300_000, 3)).toBe(600_000);
  });
});

describe("/build guards (§10 Builder)", () => {
  it("rejects an unknown blueprint (correlationId preserved)", async () => {
    const world: World = { gold: 150, blueprint: null, hasPlot: true, playerExists: true, plotInserts: 0, published: [] };
    const cap = landCapability();
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "nope" } }), makeCtx(world));
    const rej = world.published.find((e) => e.type === "build.rejected");
    expect(rej?.correlationId).toBe("cmd_1");
    expect(world.published.find((e) => e.type === "trade.request")).toBeUndefined();
  });

  it("auto-provisions a starter plot on first /build and proceeds to the charge handshake", async () => {
    const world: World = { gold: 150, blueprint: farm, hasPlot: false, playerExists: true, plotInserts: 0, published: [] };
    const cap = landCapability();
    const ctx = makeCtx(world);
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), ctx);
    // The DB-only starter plot was staked (iteration-1 shortcut, §2.1)...
    expect(world.plotInserts).toBe(1);
    expect(world.published.find((e) => e.type === "build.rejected")).toBeUndefined();
    // ...and the flow proceeded straight to the cost trade.
    const req = world.published.find((e) => e.type === "trade.request");
    expect(req?.correlationId).toBe("cmd_1");
    // Settling the charge enqueues onto the new plot.
    await cap.handle!(evt({ type: "trade.completed", correlationId: "cmd_1" }), ctx);
    expect(world.published.find((e) => e.type === "build.queued")).toBeDefined();
  });

  it("does not re-provision a plot the player already has", async () => {
    const world: World = { gold: 150, blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [] };
    const cap = landCapability();
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));
    expect(world.plotInserts).toBe(0);
    expect(world.published.find((e) => e.type === "trade.request")).toBeDefined();
  });

  it("routes an unaffordable build to the trade — the atomic ledger is the authority", async () => {
    const world: World = { gold: 10, blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [] };
    const cap = landCapability();
    const ctx = makeCtx(world);
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), ctx);
    // No early reject: the trade decides affordability and fails cleanly.
    expect(world.published.find((e) => e.type === "build.rejected")).toBeUndefined();
    expect(world.published.find((e) => e.type === "trade.request")).toBeDefined();
    await cap.handle!(evt({ type: "trade.failed", correlationId: "cmd_1" }), ctx);
    expect(world.published.find((e) => e.type === "build.rejected")).toBeDefined();
  });

  it("publishes a trade.request (cost via trade) when guards pass", async () => {
    const world: World = { gold: 150, blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [] };
    const cap = landCapability();
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));
    const req = world.published.find((e) => e.type === "trade.request");
    expect(req?.payload).toMatchObject({ item: "build_permit", qty: 1, price: 50 });
    expect(req?.correlationId).toBe("cmd_1"); // same id resolves the reply
    expect(world.published.find((e) => e.type === "build.queued")).toBeUndefined(); // not yet
  });
});

describe("land plot channel provisioning (§2.4)", () => {
  it("creates text+voice channels under the Land category and stores their ids", async () => {
    const world: World = {
      gold: 150, blueprint: farm, hasPlot: false, playerExists: true, plotInserts: 0, published: [],
      landCategoryId: "cat1",
    };
    const cap = landCapability();
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));
    expect(world.plotInserts).toBe(1);
    expect(world.plotChannelCalls).toBe(1);
    expect(world.channelUpdates).toBe(1); // ids persisted to land_plots
  });

  it("leaves the plot DB-only (no channel call) when no Land category is seeded", async () => {
    const world: World = {
      gold: 150, blueprint: farm, hasPlot: false, playerExists: true, plotInserts: 0, published: [],
    };
    const cap = landCapability();
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));
    expect(world.plotChannelCalls).toBeUndefined();
    expect(world.channelUpdates).toBeUndefined();
    // provisioning never blocks the build — the flow still reaches the cost trade.
    expect(world.published.find((e) => e.type === "trade.request")).toBeDefined();
  });

  it("back-fills channels for an existing plot that has none", async () => {
    const world: World = {
      gold: 150, blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [],
      existingChannel: null, landCategoryId: "cat1",
    };
    const cap = landCapability();
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));
    expect(world.plotInserts).toBe(0); // not re-staked
    expect(world.plotChannelCalls).toBe(1);
    expect(world.channelUpdates).toBe(1);
  });

  it("does not touch channels when the plot already has one", async () => {
    const world: World = {
      gold: 150, blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [],
      existingChannel: "chan1", landCategoryId: "cat1",
    };
    const cap = landCapability();
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));
    expect(world.plotChannelCalls).toBeUndefined();
    expect(world.channelUpdates).toBeUndefined();
  });

  it("skips the id write when provisioning fails (missing Manage Channels)", async () => {
    const world: World = {
      gold: 150, blueprint: farm, hasPlot: false, playerExists: true, plotInserts: 0, published: [],
      landCategoryId: "cat1", provisionFails: true,
    };
    const cap = landCapability();
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), makeCtx(world));
    expect(world.plotChannelCalls).toBe(1);
    expect(world.channelUpdates).toBeUndefined(); // no ids to store
    expect(world.published.find((e) => e.type === "trade.request")).toBeDefined();
  });
});

describe("build completion → notify (§5.9, exactly-once)", () => {
  it("flips the queue row and asks notify to ping the owner", async () => {
    const world: World = {
      gold: 150, blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [],
      completeRow: { owner_id: "u1", blueprint_id: "farm" },
    };
    const cap = landCapability();
    await cap.handle!(evt({ type: "build.completed", payload: { queue_id: "q1" } }), makeCtx(world));
    const n = world.published.find((e) => e.type === "notify.requested");
    expect(n).toBeDefined();
    expect(String(n?.payload?.message)).toContain("farm");
  });

  it("no-ops (no notify) when the completion transition already happened", async () => {
    const world: World = {
      gold: 150, blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [],
      completeRow: null, // the guarded UPDATE returns no row on a replayed tick
    };
    const cap = landCapability();
    await cap.handle!(evt({ type: "build.completed", payload: { queue_id: "q1" } }), makeCtx(world));
    expect(world.published.find((e) => e.type === "notify.requested")).toBeUndefined();
  });
});

describe("/build charge handshake (§5.5 → §5.12)", () => {
  it("enqueues the build with a build.queued result once the cost trade settles", async () => {
    const world: World = { gold: 150, blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [] };
    const cap = landCapability();
    const ctx = makeCtx(world);
    // 1) request → trade.request pending under cmd_1
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), ctx);
    // 2) the builder's trade emits trade.completed with the same corr id
    await cap.handle!(evt({ type: "trade.completed", correlationId: "cmd_1" }), ctx);
    const queued = world.published.find((e) => e.type === "build.queued");
    expect(queued?.correlationId).toBe("cmd_1");
    expect(queued?.payload?.blueprint).toBe("farm");
    expect(String(queued?.payload?.message)).toContain("Foundation laid");
  });

  it("rejects the build when the cost trade fails", async () => {
    const world: World = { gold: 150, blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [] };
    const cap = landCapability();
    const ctx = makeCtx(world);
    await cap.handle!(evt({ type: "build.requested", payload: { blueprint: "farm" } }), ctx);
    await cap.handle!(evt({ type: "trade.failed", correlationId: "cmd_1" }), ctx);
    expect(world.published.find((e) => e.type === "build.rejected")).toBeDefined();
    expect(world.published.find((e) => e.type === "build.queued")).toBeUndefined();
  });

  it("ignores trade settlements for charges it is not awaiting (broadcast bus)", async () => {
    const world: World = { gold: 150, blueprint: farm, hasPlot: true, playerExists: true, plotInserts: 0, published: [] };
    const cap = landCapability();
    const ctx = makeCtx(world);
    await cap.handle!(evt({ type: "trade.completed", correlationId: "some_other_trade" }), ctx);
    expect(world.published).toEqual([]);
  });
});
