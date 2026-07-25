/**
 * Unit tests for world.mirror (§9 cross-guild): a `world.announce` event fans its
 * rendered message out to EVERY continent's town-crier (locations kind='crier').
 * Postgres + the gateway are faked — we assert the query→fan-out wiring.
 */
import { describe, it, expect } from "vitest";
import { worldMirrorCapability } from "../src/capabilities/world-mirror.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";

interface World {
  criers: { channel_id: string | null }[];
  posts: { channelId: string; content: string }[];
  /** channel ids whose send() should throw (deleted channel / missing perm). */
  failing?: Set<string>;
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM locations") && q.includes("kind = 'crier'")) return Promise.resolve(world.criers);
    return Promise.resolve([]);
  };
  return {
    bot: "herald",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {} as unknown as CapabilityContext["bus"],
    gateway: {
      sendToChannel: async (channelId: string, content: { content?: string }) => {
        if (world.failing?.has(channelId)) throw new Error("Missing Permissions");
        world.posts.push({ channelId, content: content.content ?? "" });
        return "msg_1";
      },
    } as unknown as CapabilityContext["gateway"],
    personas: {} as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

function announce(message?: string): BusEvent {
  return {
    dbId: "0", eventId: "e_ann", type: "world.announce", ts: "", guildId: "g1",
    actor: { kind: "world", id: "auction" }, subject: null,
    payload: message === undefined ? {} : { message }, correlationId: null,
  } as BusEvent;
}

describe("world.mirror (§9)", () => {
  it("mirrors the announcement to every continent's crier", async () => {
    const world: World = { criers: [{ channel_id: "crier1" }, { channel_id: "crier2" }], posts: [] };
    await worldMirrorCapability().handle!(announce("📢 news"), makeCtx(world));
    expect(world.posts).toEqual([
      { channelId: "crier1", content: "📢 news" },
      { channelId: "crier2", content: "📢 news" },
    ]);
  });

  it("skips criers with no mapped channel", async () => {
    const world: World = { criers: [{ channel_id: "crier1" }, { channel_id: null }], posts: [] };
    await worldMirrorCapability().handle!(announce("hi"), makeCtx(world));
    expect(world.posts.map((p) => p.channelId)).toEqual(["crier1"]);
  });

  it("no-ops on an announce with no message", async () => {
    const world: World = { criers: [{ channel_id: "crier1" }], posts: [] };
    await worldMirrorCapability().handle!(announce(), makeCtx(world));
    expect(world.posts).toHaveLength(0);
  });

  it("keeps broadcasting when one continent's channel throws", async () => {
    const world: World = {
      criers: [{ channel_id: "crier1" }, { channel_id: "boom" }, { channel_id: "crier3" }],
      posts: [],
      failing: new Set(["boom"]),
    };
    await worldMirrorCapability().handle!(announce("news"), makeCtx(world));
    expect(world.posts.map((p) => p.channelId)).toEqual(["crier1", "crier3"]);
  });
});
