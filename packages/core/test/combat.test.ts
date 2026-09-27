/**
 * Unit tests for the combat verbs the warden_muster and warden_dispatch
 * workflows (§7) compose. Postgres, Discord and the ledger are faked — the
 * atomic economy is the integration suite's job — so what's asserted here is
 * the plain-data events each verb publishes, the SQL it decides to run, and the
 * guards. Mirrors research.test.ts / land.test.ts.
 *
 * The two properties worth the most here are the ones a live server would only
 * reveal expensively: that a redelivered tick can't re-roll a battle or
 * re-grant its loot, and that loot never bypasses `trade` on its way to the
 * ledger.
 */
import { describe, it, expect } from "vitest";
import { combatCapability, MAX_MUSTER } from "../src/capabilities/combat.js";
import { MUSTER_PERMIT_ITEM } from "../src/world/items.js";
import { MUSTER_COST } from "../src/combat/types.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";

interface Published {
  type: string;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
  subject?: { kind: string; id: string } | null;
}

interface World {
  playerExists: boolean;
  barracks: boolean;
  encounter: Record<string, unknown> | null;
  /** The champion row ensureChampion's upsert returns. */
  champion: Record<string, unknown>;
  /** Idle troop stacks available to dispatch. */
  troops: Record<string, unknown>[];
  /** The pending stack muster.enqueue reads (null = none). */
  pending?: { id: string; qty: number; unit_type: string } | null;
  /** Row the guarded muster completion UPDATE returns (null = already done). */
  musterCompleteRow?: Record<string, unknown> | null;
  /** The travelling battle dispatch combat.resolve reads (null = already resolved). */
  resolveRow?: Record<string, unknown> | null;
  /** When set, the resolve transaction's claim finds no row — another pass won. */
  claimLost?: boolean;
  /** When set, the battles INSERT throws inside the resolve transaction. */
  failBattleInsert?: boolean;
  /** Row the guarded returning→done UPDATE returns (null = redelivered). */
  returnRow?: Record<string, unknown> | null;
  published: Published[];
  /** Every SQL statement the verbs ran, for asserting what was written. */
  queries: string[];
  /** Channels/threads the gateway was asked to write to. */
  posted: { target: string; hasEmbed: boolean }[];
  threadCreated: boolean;
  landChannel: string | null;
}

function baseWorld(over: Partial<World> = {}): World {
  return {
    playerExists: true,
    barracks: true,
    encounter: null,
    champion: { id: "champion_u1", kind: "champion", unit_type: "infantry", qty: 1, atk: 12, def: 8, hp: 60, status: "idle" },
    troops: [],
    published: [],
    queries: [],
    posted: [],
    threadCreated: true,
    landChannel: "land_chan",
    ...over,
  };
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    world.queries.push(q);
    if (q.includes("FROM encounter_catalog")) return Promise.resolve(world.encounter ? [world.encounter] : []);
    if (q.includes("FROM build_queue")) return Promise.resolve(world.barracks ? [{ one: 1 }] : []);
    if (q.includes("INSERT INTO units") && q.includes("champion")) return Promise.resolve([world.champion]);
    if (q.includes("SELECT id, qty, unit_type FROM units")) return Promise.resolve(world.pending ? [world.pending] : []);
    if (q.includes("UPDATE units SET status = 'idle' WHERE id = ") && q.includes("status = 'training'"))
      return Promise.resolve(
        world.musterCompleteRow === undefined
          ? [{ owner_id: "u1", qty: 3, unit_type: "infantry" }]
          : world.musterCompleteRow
            ? [world.musterCompleteRow]
            : [],
      );
    if (q.includes("kind = 'troop'") && q.includes("status = 'idle'")) return Promise.resolve(world.troops);
    if (q.includes("FROM dispatches") && q.includes("status = 'travelling'")) {
      // Stand in for Postgres applying the WHERE clause: the read only finds the
      // row if the statement's own mission-kind predicate matches the row's kind.
      // That makes the guard testable instead of merely asserting on query text.
      const missionKind = (world.resolveRow?.mission as { kind?: string } | undefined)?.kind ?? "battle";
      if (q.includes("mission->>'kind' = 'battle'") && missionKind !== "battle") return Promise.resolve([]);
      return Promise.resolve(world.resolveRow ? [world.resolveRow] : []);
    }
    if (q.includes("UPDATE dispatches SET status = 'done'"))
      return Promise.resolve(world.returnRow ? [world.returnRow] : []);
    if (q.includes("SELECT tier FROM players")) return Promise.resolve([{ tier: 1 }]);
    if (q.includes("FROM land_plots")) return Promise.resolve([{ text_channel_id: world.landChannel }]);
    return Promise.resolve([]);
  };
  // Events published with a transaction are held until it commits, and dropped
  // if it throws — the transactional-emit contract the real bus gives.
  let pendingTx: Published[] | null = null;
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = (strings: TemplateStringsArray): Promise<unknown[]> => {
      const q = strings.join("?");
      world.queries.push(q);
      if (q.includes("INSERT INTO players")) return Promise.resolve(world.playerExists ? [] : [{ discord_user_id: "u1" }]);
      if (q.includes("UPDATE dispatches SET status = 'returning'") && q.includes("RETURNING id"))
        return Promise.resolve(world.claimLost ? [] : [{ id: "dsp_1" }]);
      if (q.includes("INSERT INTO battles") && world.failBattleInsert) return Promise.reject(new Error("insert failed"));
      return Promise.resolve([]);
    };
    pendingTx = [];
    try {
      const out = await fn(tx);
      world.published.push(...pendingTx);
      return out;
    } finally {
      pendingTx = null;
    }
  };
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log };
  return {
    bot: "warden",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: Published, tx?: unknown) => {
        (tx && pendingTx ? pendingTx : world.published).push(input);
        return input as never;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: {
      createPrivateThread: async () => (world.threadCreated ? "thread_1" : null),
      sendToChannel: async (target: string, content: { embeds?: unknown[] }) => {
        world.posted.push({ target, hasEmbed: Boolean(content?.embeds?.length) });
        return "msg_1";
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
    subject: { kind: "npc", id: "warden" },
    payload: {},
    correlationId: "cmd_1",
    ...over,
  };
}

const cap = combatCapability();
function verb(name: string, args: Record<string, unknown>, e: BusEvent, ctx: CapabilityContext) {
  return cap.actions[name]!(args, e, ctx);
}

const WOLVES = {
  id: "moor_wolves",
  name: "Moor Wolves",
  unit_type: "cavalry",
  atk: 14,
  def: 4,
  hp: 90,
  travel_ms: 300_000,
  loot: [{ item: "wolf_pelt", qty: 2, chance: 1 }],
  reward_gold: 40,
};

describe("muster.request guards (§2.6 troops come from buildings)", () => {
  it("charges through `trade` when the guards pass", async () => {
    const world = baseWorld();
    const ctx = makeCtx(world);
    await verb("muster.request", {}, evt({ type: "muster.requested", payload: { type: "infantry", count: "3" } }), ctx);

    const charge = world.published.find((p) => p.type === "trade.request");
    expect(charge).toBeDefined();
    expect(charge!.payload).toMatchObject({ item: MUSTER_PERMIT_ITEM, price: MUSTER_COST.infantry * 3 });
    expect(charge!.correlationId).toBe("cmd_1");
    // The pending stack is recorded before the charge, keyed by correlation.
    expect(world.queries.some((q) => q.includes("INSERT INTO units") && q.includes("'training'"))).toBe(true);
  });

  it("rejects an unknown unit type and never charges", async () => {
    const world = baseWorld();
    const ctx = makeCtx(world);
    await expect(
      verb("muster.request", {}, evt({ type: "muster.requested", payload: { type: "siege", count: "3" } }), ctx),
    ).rejects.toThrow();
    expect(world.published.map((p) => p.type)).toEqual(["muster.rejected"]);
  });

  it("rejects a count outside 1..MAX_MUSTER", async () => {
    for (const count of ["0", String(MAX_MUSTER + 1), "abc", "2.5"]) {
      const world = baseWorld();
      const ctx = makeCtx(world);
      await expect(
        verb("muster.request", {}, evt({ type: "muster.requested", payload: { type: "infantry", count } }), ctx),
      ).rejects.toThrow();
      expect(world.published.map((p) => p.type)).toEqual(["muster.rejected"]);
    }
  });

  it("rejects when no barracks has been built", async () => {
    const world = baseWorld({ barracks: false });
    const ctx = makeCtx(world);
    await expect(
      verb("muster.request", {}, evt({ type: "muster.requested", payload: { type: "infantry", count: "3" } }), ctx),
    ).rejects.toThrow();
    expect(world.published.map((p) => p.type)).toEqual(["muster.rejected"]);
    expect(world.published[0]!.payload!.message).toContain("barracks");
  });
});

describe("muster.enqueue / complete", () => {
  it("times the pending stack and announces it", async () => {
    const world = baseWorld({ pending: { id: "unit_1", qty: 3, unit_type: "infantry" } });
    const ctx = makeCtx(world);
    await verb("muster.enqueue", {}, evt({ type: "trade.completed" }), ctx);

    const queued = world.published.find((p) => p.type === "muster.queued");
    expect(queued).toBeDefined();
    expect(queued!.payload!.unit_id).toBe("unit_1");
    expect(queued!.correlationId).toBe("cmd_1");
    expect(world.queries.some((q) => q.includes("UPDATE units SET ready_at"))).toBe(true);
  });

  it("no-ops when the charge matches no pending stack", async () => {
    const world = baseWorld({ pending: null });
    const ctx = makeCtx(world);
    await verb("muster.enqueue", {}, evt({ type: "trade.completed" }), ctx);
    expect(world.published).toEqual([]);
  });

  it("notifies once on completion", async () => {
    const world = baseWorld();
    const ctx = makeCtx(world);
    await verb("muster.complete", {}, evt({ type: "muster.completed", payload: { unit_id: "unit_1" } }), ctx);
    expect(world.published.map((p) => p.type)).toEqual(["notify.requested"]);
  });

  it("stays silent when a redelivered tick finds the stack already mustered", async () => {
    const world = baseWorld({ musterCompleteRow: null });
    const ctx = makeCtx(world);
    await verb("muster.complete", {}, evt({ type: "muster.completed", payload: { unit_id: "unit_1" } }), ctx);
    expect(world.published).toEqual([]);
  });
});

describe("dispatch.request (§5.13 the dispatch primitive)", () => {
  it("snapshots the force, ties the units up, and sends it", async () => {
    const world = baseWorld({
      encounter: WOLVES,
      troops: [{ id: "unit_1", kind: "troop", unit_type: "infantry", qty: 5, atk: 8, def: 6, hp: 30, status: "idle" }],
    });
    const ctx = makeCtx(world);
    await verb("dispatch.request", {}, evt({ type: "dispatch.requested", payload: { encounter: "moor_wolves" } }), ctx);

    const sent = world.published.find((p) => p.type === "dispatch.sent");
    expect(sent).toBeDefined();
    expect(sent!.payload!.encounter).toBe("moor_wolves");
    expect(sent!.correlationId).toBe("cmd_1");
    expect(world.queries.some((q) => q.includes("INSERT INTO dispatches"))).toBe(true);
    // The force is tied up by explicit id, never by a blanket owner-wide update.
    const tieUp = world.queries.find((q) => q.includes("UPDATE units SET status = 'dispatched'"));
    expect(tieUp).toBeDefined();
    expect(tieUp).toContain("id = ANY(");
    // No gold changes hands — §2.6 prices a fight in sunk prep, not a fee.
    expect(world.published.some((p) => p.type === "trade.request")).toBe(false);
  });

  it("sends the champion alone when no troops are idle (§2.6 solo fight)", async () => {
    const world = baseWorld({ encounter: WOLVES, troops: [] });
    const ctx = makeCtx(world);
    await verb("dispatch.request", {}, evt({ type: "dispatch.requested", payload: { encounter: "moor_wolves" } }), ctx);
    expect(world.published.some((p) => p.type === "dispatch.sent")).toBe(true);
  });

  it("rejects an unknown encounter", async () => {
    const world = baseWorld({ encounter: null });
    const ctx = makeCtx(world);
    await expect(
      verb("dispatch.request", {}, evt({ type: "dispatch.requested", payload: { encounter: "nope" } }), ctx),
    ).rejects.toThrow();
    expect(world.published.map((p) => p.type)).toEqual(["dispatch.rejected"]);
  });

  it("rejects a second dispatch while the champion is still afield", async () => {
    const world = baseWorld({
      encounter: WOLVES,
      champion: { id: "champion_u1", kind: "champion", unit_type: "infantry", qty: 1, atk: 12, def: 8, hp: 60, status: "dispatched" },
    });
    const ctx = makeCtx(world);
    await expect(
      verb("dispatch.request", {}, evt({ type: "dispatch.requested", payload: { encounter: "moor_wolves" } }), ctx),
    ).rejects.toThrow();
    expect(world.published.map((p) => p.type)).toEqual(["dispatch.rejected"]);
    expect(world.queries.some((q) => q.includes("INSERT INTO dispatches"))).toBe(false);
  });
});

describe("combat.resolve", () => {
  /** A dispatch mid-flight, with a force strong enough to win. */
  function arrived(force?: unknown) {
    return {
      owner_id: "u1",
      mission: { kind: "battle", encounter_id: "moor_wolves" },
      force: force ?? {
        troops: [{ unitId: "unit_1", unitType: "infantry", qty: 12, atk: 8, def: 6, hp: 30 }],
        champion: { unitId: "champion_u1", unitType: "infantry", level: 1, atk: 12, def: 8, hp: 60 },
      },
      origin_guild_id: "g1",
    };
  }

  it("resolves, records the battle, and delivers the log to a private thread", async () => {
    const world = baseWorld({ encounter: WOLVES, resolveRow: arrived() });
    const ctx = makeCtx(world);
    await verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx);

    expect(world.queries.some((q) => q.includes("INSERT INTO battles"))).toBe(true);
    expect(world.posted).toEqual([{ target: "thread_1", hasEmbed: true }]);
    const resolved = world.published.find((p) => p.type === "combat.resolved");
    expect(resolved).toBeDefined();
    expect(resolved!.payload!.outcome).toBe("victory");
    // The seed is recorded so the fight can be replayed (§5.13 auditability).
    expect(resolved!.payload!.seed).toEqual(expect.any(String));
    // The force starts home rather than lingering at the encounter.
    expect(world.queries.some((q) => q.includes("UPDATE dispatches SET status = 'returning'"))).toBe(true);
  });

  it("routes every spoil through `trade` rather than writing the ledger", async () => {
    const world = baseWorld({ encounter: WOLVES, resolveRow: arrived() });
    const ctx = makeCtx(world);
    await verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx);

    const grants = world.published.filter((p) => p.type === "grant.requested");
    // 40 reward gold + the certain wolf_pelt drop.
    expect(grants.map((g) => g.payload)).toEqual([{ gold: 40 }, { item: "wolf_pelt", qty: 2 }]);
    // Addressed to this bot's own trade capability, which performs the grant.
    expect(grants.every((g) => g.subject?.id === "warden")).toBe(true);
    // Nothing in this capability touches the economy tables directly.
    expect(world.queries.some((q) => /INSERT INTO (ledger|balances|inventories)/.test(q))).toBe(false);
  });

  it("awards nothing on a defeat (§2.6 losing costs only the loot chance)", async () => {
    const world = baseWorld({
      encounter: WOLVES,
      // One weak archer stack against its counter — a reliable loss.
      resolveRow: arrived({ troops: [{ unitId: "unit_1", unitType: "archer", qty: 1, atk: 14, def: 2, hp: 18 }], champion: null }),
    });
    const ctx = makeCtx(world);
    await verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx);

    expect(world.published.find((p) => p.type === "combat.resolved")!.payload!.outcome).toBe("defeat");
    expect(world.published.some((p) => p.type === "grant.requested")).toBe(false);
    // The log is still delivered — a loss is still a report.
    expect(world.posted).toHaveLength(1);
  });

  it("leaves another mission kind's dispatch alone (§5.13 the primitive is shared)", async () => {
    // The tick sweeps every travelling dispatch, so a §11 caravan in flight is
    // offered to this verb too. Claiming it would march a trade mission into a
    // battle it never packed for.
    const world = baseWorld({
      encounter: WOLVES,
      resolveRow: { ...arrived(), mission: { kind: "caravan", destination_guild_id: "g2" } },
    });
    const ctx = makeCtx(world);
    await verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx);

    expect(world.published).toEqual([]);
    expect(world.queries.some((q) => q.includes("INSERT INTO battles"))).toBe(false);
    // Nor is it recalled — the caravan stays travelling for its own verb to claim.
    expect(world.queries.some((q) => q.includes("UPDATE dispatches SET status = 'returning'"))).toBe(false);
  });

  it("cannot be re-run by a redelivered tick", async () => {
    // Once resolved the row is no longer travelling, so the read finds nothing.
    const world = baseWorld({ encounter: WOLVES, resolveRow: null });
    const ctx = makeCtx(world);
    await verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx);

    expect(world.published).toEqual([]);
    expect(world.posted).toEqual([]);
    expect(world.queries.some((q) => q.includes("INSERT INTO battles"))).toBe(false);
  });

  it("grants nothing when another pass claims the dispatch first", async () => {
    // Two deliveries read the row as travelling; only one claim can land.
    const world = baseWorld({ encounter: WOLVES, resolveRow: arrived(), claimLost: true });
    const ctx = makeCtx(world);
    await verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx);

    expect(world.published).toEqual([]);
    expect(world.posted).toEqual([]);
    expect(world.queries.some((q) => q.includes("INSERT INTO battles"))).toBe(false);
  });

  it("pays out nothing when the transaction fails part-way (no stranded state)", async () => {
    // The claim and the battle row commit together with the grants. If the
    // insert throws, all of it rolls back: no grant escapes, no log is posted,
    // and the dispatch is still travelling for the tick to re-fire.
    const world = baseWorld({ encounter: WOLVES, resolveRow: arrived(), failBattleInsert: true });
    const ctx = makeCtx(world);
    await expect(
      verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx),
    ).rejects.toThrow("insert failed");

    expect(world.published).toEqual([]);
    expect(world.posted).toEqual([]);
  });

  it("never parks a dispatch in an intermediate state", async () => {
    const world = baseWorld({ encounter: WOLVES, resolveRow: arrived() });
    const ctx = makeCtx(world);
    await verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx);
    expect(world.queries.some((q) => q.includes("'resolving'"))).toBe(false);
    // The thread id is back-filled once the log has been delivered.
    expect(world.queries.some((q) => q.includes("UPDATE battles SET thread_id"))).toBe(true);
  });

  it("falls back to the land channel when a thread can't be opened", async () => {
    const world = baseWorld({ encounter: WOLVES, resolveRow: arrived(), threadCreated: false });
    const ctx = makeCtx(world);
    await verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx);
    expect(world.posted).toEqual([{ target: "land_chan", hasEmbed: true }]);
    // The battle still resolved — Discord never blocks the fight.
    expect(world.published.some((p) => p.type === "combat.resolved")).toBe(true);
  });

  it("still resolves when the player has no land channel at all", async () => {
    const world = baseWorld({ encounter: WOLVES, resolveRow: arrived(), landChannel: null });
    const ctx = makeCtx(world);
    await verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx);
    expect(world.posted).toEqual([]);
    expect(world.queries.some((q) => q.includes("INSERT INTO battles"))).toBe(true);
  });

  it("recalls the force when the encounter vanished mid-flight", async () => {
    const world = baseWorld({ encounter: null, resolveRow: arrived() });
    const ctx = makeCtx(world);
    await verb("combat.resolve", {}, evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } }), ctx);
    expect(world.queries.some((q) => q.includes("UPDATE dispatches SET status = 'returning'"))).toBe(true);
    expect(world.queries.some((q) => q.includes("INSERT INTO battles"))).toBe(false);
  });
});

describe("dispatch.return (§2.6 no PvE losses)", () => {
  it("frees exactly the units that were sent", async () => {
    const world = baseWorld({
      returnRow: {
        owner_id: "u1",
        force: {
          troops: [{ unitId: "unit_1", unitType: "infantry", qty: 5, atk: 8, def: 6, hp: 30 }],
          champion: { unitId: "champion_u1", unitType: "infantry", level: 1, atk: 12, def: 8, hp: 60 },
        },
      },
    });
    const ctx = makeCtx(world);
    await verb("dispatch.return", {}, evt({ type: "dispatch.returned", payload: { dispatch_id: "dsp_1" } }), ctx);

    const free = world.queries.find((q) => q.includes("UPDATE units SET status = 'idle'") && q.includes("id = ANY("));
    expect(free).toBeDefined();
    expect(world.published.map((p) => p.type)).toEqual(["notify.requested"]);
  });

  it("stays silent when a redelivered tick finds the force already home", async () => {
    const world = baseWorld({ returnRow: null });
    const ctx = makeCtx(world);
    await verb("dispatch.return", {}, evt({ type: "dispatch.returned", payload: { dispatch_id: "dsp_1" } }), ctx);
    expect(world.published).toEqual([]);
  });
});
