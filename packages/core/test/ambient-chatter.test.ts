/**
 * Unit tests for ambient.chatter (§5.8): a reacted-to world event posts a framing
 * line (with the event's rumour hint woven in) into the guild's bazaar text chat,
 * throttled per guild. Postgres + the gateway are faked — we assert the
 * resolve-bazaar → compose → post wiring and the throttle rules.
 */
import { describe, it, expect } from "vitest";
import { ambientChatterCapability } from "../src/capabilities/ambient-chatter.js";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";

interface World {
  bazaars: Record<string, string>; // guildId -> bazaar channel id
  posts: { channelId: string; content: string }[];
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM locations")) {
      const guildId = String(vals[0]); // WHERE guild_id = ${guildId} AND kind = ${kind}
      const channel = world.bazaars[guildId];
      return Promise.resolve(channel ? [{ channel_id: channel }] : []);
    }
    return Promise.resolve([]);
  };
  return {
    bot: "merchant",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {} as unknown as CapabilityContext["bus"],
    gateway: {
      sendToChannel: async (channelId: string, content: { content?: string }) => {
        world.posts.push({ channelId, content: content.content ?? "" });
        return "msg_1";
      },
    } as unknown as CapabilityContext["gateway"],
    personas: {} as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

function rumor(guildId: string | null, hint?: string): BusEvent {
  return {
    dbId: "0", eventId: "e_rumor", type: "world.rumor", ts: "", guildId,
    actor: null, subject: { kind: "npc", id: "secret_merchant" },
    payload: hint ? { hint } : {}, correlationId: null,
  };
}

const CONFIG = { reactions: { "world.rumor": ["Did you hear...?"] } };

describe("ambient.chatter (§5.8)", () => {
  it("posts the framing line + the rumour hint into the guild's bazaar", async () => {
    const world: World = { bazaars: { g1: "bazaar1" }, posts: [] };
    await ambientChatterCapability(CONFIG).handle!(rumor("g1", "A hooded stranger was glimpsed."), makeCtx(world));
    expect(world.posts).toEqual([{ channelId: "bazaar1", content: "*Did you hear...?* A hooded stranger was glimpsed." }]);
  });

  it("posts just the framing line when the event carries no hint", async () => {
    const world: World = { bazaars: { g1: "bazaar1" }, posts: [] };
    await ambientChatterCapability(CONFIG).handle!(rumor("g1"), makeCtx(world));
    expect(world.posts).toEqual([{ channelId: "bazaar1", content: "Did you hear...?" }]);
  });

  it("throttles repeat reactions within the same guild", async () => {
    const world: World = { bazaars: { g1: "bazaar1" }, posts: [] };
    const cap = ambientChatterCapability(CONFIG);
    const ctx = makeCtx(world);
    await cap.handle!(rumor("g1", "first"), ctx);
    await cap.handle!(rumor("g1", "second"), ctx); // within throttle window → suppressed
    expect(world.posts).toHaveLength(1);
    expect(world.posts[0]!.content).toContain("first");
  });

  it("throttle is per guild — a different continent still reacts", async () => {
    const world: World = { bazaars: { g1: "bazaar1", g2: "bazaar2" }, posts: [] };
    const cap = ambientChatterCapability(CONFIG);
    const ctx = makeCtx(world);
    await cap.handle!(rumor("g1", "in one"), ctx);
    await cap.handle!(rumor("g2", "in two"), ctx);
    expect(world.posts.map((p) => p.channelId)).toEqual(["bazaar1", "bazaar2"]);
  });

  it("skips events with no location (nowhere to post)", async () => {
    const world: World = { bazaars: { g1: "bazaar1" }, posts: [] };
    await ambientChatterCapability(CONFIG).handle!(rumor(null, "orphan"), makeCtx(world));
    expect(world.posts).toHaveLength(0);
  });

  it("ignores event types with no configured reaction", async () => {
    const world: World = { bazaars: { g1: "bazaar1" }, posts: [] };
    const evt = { ...rumor("g1", "x"), type: "trade.completed" } as BusEvent;
    await ambientChatterCapability(CONFIG).handle!(evt, makeCtx(world));
    expect(world.posts).toHaveLength(0);
  });
});
