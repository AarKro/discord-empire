/**
 * Unit tests for wayfare (§9 player travel): depart validates the ring hop, clears
 * position ("on the road"), and confirms via command.reply; a bad hop replies with
 * the reason then throws (→ workflow on_error). arrive sets the new position and
 * posts a public arrival line to the destination's bazaar. Postgres (incl.
 * ensurePlayer's transaction) and the gateway are faked.
 */
import { describe, it, expect } from "vitest";
import { wayfareCapability } from "../src/capabilities/wayfare.js";
import type { Continents } from "@empire/content-schemas";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";

const TWO: Continents = {
  continents: {
    g1: { name: "Continent One", order: 1, neighbors: ["g2"] },
    g2: { name: "Continent Two", order: 2, neighbors: ["g1"] },
  },
};

interface World {
  position: string | null;
  playerExists: boolean;
  bazaars: Record<string, string>;
  replies: { message: string; correlationId: string | null }[];
  posts: { channelId: string; content: string }[];
}

function makeCtx(world: World): CapabilityContext {
  const fn = (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("INSERT INTO players")) return Promise.resolve(world.playerExists ? [] : [{ discord_user_id: "p1" }]);
    if (q.includes("SELECT position_guild_id FROM players")) return Promise.resolve([{ position_guild_id: world.position }]);
    if (q.includes("UPDATE players SET position_guild_id")) {
      world.position = (vals[0] as string | null) ?? null;
      return Promise.resolve([]);
    }
    if (q.includes("FROM locations")) {
      const guildId = String(vals[0]);
      return Promise.resolve(world.bazaars[guildId] ? [{ channel_id: world.bazaars[guildId] }] : []);
    }
    return Promise.resolve([]); // balances / ledger inserts
  };
  const sql = Object.assign(fn, { begin: async (cb: (tx: unknown) => unknown) => cb(sql) });
  return {
    bot: "herald",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string; payload?: { message?: string }; correlationId?: string | null }) => {
        if (input.type === "command.reply") world.replies.push({ message: input.payload!.message!, correlationId: input.correlationId ?? null });
        return undefined;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: {
      sendToChannel: async (channelId: string, content: { content?: string }) => {
        world.posts.push({ channelId, content: content.content ?? "" });
        return "msg_1";
      },
    } as unknown as CapabilityContext["gateway"],
    personas: { homeGuild: (g?: string) => g ?? "g1" } as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

const departEvt = (): BusEvent => ({
  dbId: "0", eventId: "e", type: "travel.requested", ts: "", guildId: "g1",
  actor: { kind: "player", id: "p1" }, subject: { kind: "npc", id: "herald" }, payload: {}, correlationId: "cmd_1",
});

describe("wayfare — player travel (§9)", () => {
  it("depart clears position and confirms the journey for a valid neighbour", async () => {
    const world: World = { position: "g1", playerExists: true, bazaars: {}, replies: [], posts: [] };
    await wayfareCapability(TWO).actions["wayfare.depart"]!({ destination: "g2" }, departEvt(), makeCtx(world));
    expect(world.position).toBeNull(); // on the road
    expect(world.replies).toHaveLength(1);
    expect(world.replies[0]).toMatchObject({ correlationId: "cmd_1" });
    expect(world.replies[0]!.message).toContain("Continent Two");
  });

  it("depart rejects a non-neighbour: replies with a reason and throws (→ on_error)", async () => {
    const world: World = { position: "g1", playerExists: true, bazaars: {}, replies: [], posts: [] };
    const run = wayfareCapability(TWO).actions["wayfare.depart"]!({ destination: "g9" }, departEvt(), makeCtx(world));
    await expect(run).rejects.toThrow();
    expect(world.position).toBe("g1"); // unchanged
    expect(world.replies[0]!.message).toContain("no road that way");
  });

  it("depart rejects a player already on the road (null position)", async () => {
    const world: World = { position: null, playerExists: true, bazaars: {}, replies: [], posts: [] };
    const run = wayfareCapability(TWO).actions["wayfare.depart"]!({ destination: "g2" }, departEvt(), makeCtx(world));
    await expect(run).rejects.toThrow();
    expect(world.replies[0]!.message).toContain("already on the road");
  });

  it("arrive sets the new position and posts a public arrival line to the bazaar", async () => {
    const world: World = { position: null, playerExists: true, bazaars: { g2: "bazaar2" }, replies: [], posts: [] };
    await wayfareCapability(TWO).actions["wayfare.arrive"]!({ destination: "g2" }, departEvt(), makeCtx(world));
    expect(world.position).toBe("g2");
    expect(world.posts).toEqual([{ channelId: "bazaar2", content: expect.stringContaining("arrives in Continent Two") }]);
  });
});
