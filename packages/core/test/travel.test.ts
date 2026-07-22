/**
 * Unit tests for travel (§9): the pure ring maths (start continent + next-hop
 * with backtrack avoidance) and the capability wiring — travel.enter joins the
 * next continent's voice stop and announces a rumour; travel.leave leaves the
 * current guild's voice, picks the next continent, and records it. Postgres and
 * the gateway are faked (a stateful npcs.state, like the dev server keeps), so we
 * assert the resolve→join/leave→state→rumour flow without Discord or a database.
 */
import { describe, it, expect } from "vitest";
import { travelCapability, startContinent, nextContinent } from "../src/capabilities/travel.js";
import type { Continents } from "@empire/content-schemas";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";

const TWO: Continents = {
  continents: {
    g1: { name: "One", order: 1, neighbors: ["g2"] },
    g2: { name: "Two", order: 2, neighbors: ["g1"] },
  },
};

const THREE: Continents = {
  continents: {
    g1: { name: "One", order: 1, neighbors: ["g2"] },
    g2: { name: "Two", order: 2, neighbors: ["g3"] },
    g3: { name: "Three", order: 3, neighbors: ["g1"] },
  },
};

interface FakeWorld {
  channels: Record<string, string>; // "<stop>_<guildId>" -> voice channel id
  state: Record<string, unknown>; // npcs.state for the traveler
  inserted: boolean;
  joins: { guildId: string; channelId: string }[];
  leaves: string[];
  rumors: { guildId: string; hint: string }[];
}

function makeCtx(world: FakeWorld): CapabilityContext {
  const sql = (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("INSERT INTO npcs")) {
      world.inserted = true;
      return Promise.resolve([]);
    }
    if (q.includes("UPDATE npcs SET state")) {
      world.state = JSON.parse(String(vals[0])) as Record<string, unknown>;
      return Promise.resolve([]);
    }
    if (q.includes("FROM npcs")) return Promise.resolve([{ state: world.state }]);
    if (q.includes("FROM locations")) {
      const ch = world.channels[String(vals[0])];
      return Promise.resolve(ch ? [{ channel_id: ch }] : []);
    }
    return Promise.resolve([]);
  };
  return {
    bot: "secret_merchant",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string; guildId?: string; payload?: { hint?: string } }) => {
        if (input.type === "world.rumor") world.rumors.push({ guildId: input.guildId!, hint: input.payload!.hint! });
        return undefined;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: {
      joinVoice: async (guildId: string, channelId: string) => {
        world.joins.push({ guildId, channelId });
        return true;
      },
      leaveVoice: (guildId: string) => {
        world.leaves.push(guildId);
      },
    } as unknown as CapabilityContext["gateway"],
    personas: { guildIds: ["g1", "g2"] } as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

function freshWorld(): FakeWorld {
  return {
    channels: { market_square_vc_g1: "vc1", market_square_vc_g2: "vc2", market_square_vc_g3: "vc3" },
    state: {},
    inserted: false,
    joins: [],
    leaves: [],
    rumors: [],
  };
}

describe("travel ring maths (§9)", () => {
  it("startContinent picks the lowest order", () => {
    expect(startContinent(TWO)).toBe("g1");
    expect(startContinent(THREE)).toBe("g1");
  });

  it("nextContinent avoids immediate backtrack, else takes the first neighbour", () => {
    // 2-continent ring: only one neighbour, so it ping-pongs regardless of avoid.
    expect(nextContinent(TWO, "g1", null)).toBe("g2");
    expect(nextContinent(TWO, "g2", "g1")).toBe("g1"); // sole neighbour wins the fallback
    // Directed 3-ring: always walks forward.
    expect(nextContinent(THREE, "g1", null)).toBe("g2");
    expect(nextContinent(THREE, "g2", "g1")).toBe("g3");
    expect(nextContinent(THREE, "g3", "g2")).toBe("g1");
  });

  it("nextContinent returns current when a continent has no neighbours", () => {
    expect(nextContinent({ continents: { g1: { name: "Lone", order: 1, neighbors: [] } } }, "g1", null)).toBe("g1");
  });
});

describe("travel capability (§9)", () => {
  it("first travel.enter appears in the starting continent and announces a rumour", async () => {
    const world = freshWorld();
    const cap = travelCapability(TWO);
    await cap.actions["travel.enter"]!({ channel: "market_square_vc" }, null as unknown as BusEvent, makeCtx(world));
    expect(world.joins).toEqual([{ guildId: "g1", channelId: "vc1" }]);
    expect(world.state).toMatchObject({ guild: "g1", destination: null, previous: null });
    expect(world.rumors).toHaveLength(1);
    expect(world.rumors[0]!.guildId).toBe("g1");
  });

  it("enter→leave→enter walks g1 → g2 (the intercontinental hop)", async () => {
    const world = freshWorld();
    const cap = travelCapability(TWO);
    // Arrive at the starting continent.
    await cap.actions["travel.enter"]!({}, null as unknown as BusEvent, makeCtx(world));
    expect(world.state).toMatchObject({ guild: "g1" });
    // Depart it: leaves g1's voice, heads for the neighbour.
    await cap.actions["travel.leave"]!({}, null as unknown as BusEvent, makeCtx(world));
    expect(world.leaves).toEqual(["g1"]);
    expect(world.state).toMatchObject({ guild: null, destination: "g2", previous: "g1" });
    // Arrive on the other continent.
    await cap.actions["travel.enter"]!({}, null as unknown as BusEvent, makeCtx(world));
    expect(world.joins).toEqual([{ guildId: "g1", channelId: "vc1" }, { guildId: "g2", channelId: "vc2" }]);
    expect(world.state).toMatchObject({ guild: "g2", destination: null, previous: "g1" });
    expect(world.rumors.map((r) => r.guildId)).toEqual(["g1", "g1", "g2"]); // arrive g1, depart g1, arrive g2
  });

  it("init seeds the npcs row and rejoins the current continent after a mid-dwell reboot", async () => {
    const world = freshWorld();
    world.state = { guild: "g2", destination: null, previous: "g1" };
    await travelCapability(TWO).init!(makeCtx(world));
    expect(world.inserted).toBe(true);
    expect(world.joins).toEqual([{ guildId: "g2", channelId: "vc2" }]);
  });

  it("init stays on the road when it rebooted mid-transit", async () => {
    const world = freshWorld();
    world.state = { guild: null, destination: "g2", previous: "g1" };
    await travelCapability(TWO).init!(makeCtx(world));
    expect(world.inserted).toBe(true);
    expect(world.joins).toHaveLength(0); // never joins a voice channel while travelling
  });

  it("init joins nothing on a never-started traveler (empty state)", async () => {
    const world = freshWorld();
    await travelCapability(TWO).init!(makeCtx(world));
    expect(world.joins).toHaveLength(0);
  });
});
