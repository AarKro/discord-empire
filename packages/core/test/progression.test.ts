/**
 * Tier progression (§2.5). The ladder rule is pure (eligibleTier); the
 * capability is tested with faked SQL for what it publishes and when it
 * declines to do anything.
 */
import { describe, it, expect } from "vitest";
import { eligibleTier, nextTier, progressionCapability, progressReport } from "../src/capabilities/progression.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";
import type { Tiers } from "@empire/content-schemas";

const TIERS: Tiers = {
  tiers: [
    { tier: 2, name: "Settler", buildings: 2, research: 1, victories: 1 },
    { tier: 3, name: "Landholder", buildings: 4, research: 2, victories: 5 },
  ],
};

describe("eligibleTier", () => {
  it("is 1 until every requirement of tier 2 is met", () => {
    expect(eligibleTier({ buildings: 9, research: 9, victories: 0 }, TIERS)).toBe(1);
  });
  it("climbs as far as the counts reach, several rungs at once", () => {
    expect(eligibleTier({ buildings: 2, research: 1, victories: 1 }, TIERS)).toBe(2);
    expect(eligibleTier({ buildings: 4, research: 2, victories: 5 }, TIERS)).toBe(3);
  });
  it("never skips a rung the counts don't meet", () => {
    // Enough of everything for tier 3 except tier 2's victory → still tier 1.
    const skipping: Tiers = {
      tiers: [
        { tier: 2, name: "A", buildings: 0, research: 0, victories: 1 },
        { tier: 3, name: "B", buildings: 1, research: 0, victories: 0 },
      ],
    };
    expect(eligibleTier({ buildings: 5, research: 0, victories: 0 }, skipping)).toBe(1);
  });
  it("names the next rung, or null at the top", () => {
    expect(nextTier(1, TIERS)?.name).toBe("Settler");
    expect(nextTier(3, TIERS)).toBeNull();
  });
});

interface World {
  counts: { buildings: number; research: number; victories: number };
  tier: number;
  published: { type: string; payload?: Record<string, unknown> }[];
  updates: number;
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("AS buildings")) return Promise.resolve([world.counts]);
    if (q.includes("SELECT tier FROM players")) return Promise.resolve([{ tier: world.tier }]);
    if (q.includes("UPDATE players SET tier")) {
      world.updates += 1;
      const target = values[0] as number;
      if (world.tier >= target) return Promise.resolve([]);
      world.tier = target;
      return Promise.resolve([{ tier: target }]);
    }
    return Promise.resolve([]);
  };
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log };
  return {
    bot: "builder",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string; payload?: Record<string, unknown> }) => {
        world.published.push(input);
        return undefined as never;
      },
    } as unknown as CapabilityContext["bus"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

const evt = (type: string, payload: Record<string, unknown> = {}, actorKind = "player"): BusEvent =>
  ({
    dbId: "1", eventId: "e1", type, ts: "", guildId: "g1",
    actor: { kind: actorKind, id: "p1" }, subject: { kind: "npc", id: "builder" }, payload, correlationId: null,
  }) as BusEvent;

describe("progression capability", () => {
  const cap = progressionCapability(TIERS);

  it("promotes on the milestone that tips it, and tells the player and the realm", async () => {
    const world: World = { counts: { buildings: 2, research: 1, victories: 1 }, tier: 1, published: [], updates: 0 };
    await cap.handle!(evt("build.finished"), makeCtx(world));
    expect(world.tier).toBe(2);
    expect(world.published.map((p) => p.type)).toEqual(["notify.requested", "world.announce"]);
    expect(String(world.published[0]!.payload!.message)).toContain("Tier 2");
  });

  it("is idempotent: a redelivered event after promotion says nothing", async () => {
    const world: World = { counts: { buildings: 2, research: 1, victories: 1 }, tier: 2, published: [], updates: 0 };
    await cap.handle!(evt("research.finished"), makeCtx(world));
    expect(world.published).toEqual([]);
  });

  it("doesn't count a lost battle (no reads, no writes)", async () => {
    const world: World = { counts: { buildings: 9, research: 9, victories: 9 }, tier: 1, published: [], updates: 0 };
    await cap.handle!(evt("combat.resolved", { outcome: "defeat" }), makeCtx(world));
    expect(world.updates).toBe(0);
    expect(world.tier).toBe(1);
  });

  it("promotes on a victory", async () => {
    const world: World = { counts: { buildings: 2, research: 1, victories: 1 }, tier: 1, published: [], updates: 0 };
    await cap.handle!(evt("combat.resolved", { outcome: "victory" }), makeCtx(world));
    expect(world.tier).toBe(2);
  });

  it("ignores events with no player behind them", async () => {
    const world: World = { counts: { buildings: 9, research: 9, victories: 9 }, tier: 1, published: [], updates: 0 };
    await cap.handle!(evt("build.finished", {}, "world"), makeCtx(world));
    expect(world.updates).toBe(0);
  });

  it("/progress shows the next rung's requirements against the player's counts", async () => {
    const world: World = { counts: { buildings: 1, research: 1, victories: 0 }, tier: 1, published: [], updates: 0 };
    const report = await progressReport(makeCtx(world).sql, "p1", TIERS);
    expect(report).toContain("Tier 2 — Settler");
    expect(report).toContain("Buildings finished: 1/2");
    expect(report).toContain("✅ Research completed: 1/1");
  });
});
