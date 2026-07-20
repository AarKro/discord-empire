/**
 * Unit tests for presence.voice wandering (§5.1): at boot the NPC takes its
 * first route stop; on each tick.hour it hops to the next, announcing npc.arrived;
 * a routeless guild just stands in its home voice channel. Postgres and the
 * gateway are faked — the real @discordjs/voice connection is a dev-server
 * concern; here we assert the resolve→join→announce wiring and the rotation.
 */
import { describe, it, expect } from "vitest";
import { presenceVoiceCapability, type WanderStop } from "../src/capabilities/presence-voice.js";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";

interface World {
  /** locations row id (e.g. "bazaar_vc_g1") → Discord voice channel id. */
  channels: Record<string, string>;
  joins: { guildId: string; channelId: string }[];
  arrivals: { guildId: string; channel: string }[];
}

function makeCtx(world: World, guildIds: string[]): CapabilityContext {
  const sql = (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM locations")) {
      if (q.includes("ORDER BY")) {
        // Home fallback: WHERE guild_id = ${guildId} ... ORDER BY id LIMIT 1
        const guildId = String(vals[0]);
        const ids = Object.keys(world.channels).filter((id) => id.endsWith(`_${guildId}`)).sort();
        return Promise.resolve(ids.length ? [{ channel_id: world.channels[ids[0]!] }] : []);
      }
      // Stop resolve: WHERE id = ${`${channel}_${guildId}`}
      const ch = world.channels[String(vals[0])];
      return Promise.resolve(ch ? [{ channel_id: ch }] : []);
    }
    return Promise.resolve([]); // UPDATE npcs, etc.
  };
  return {
    bot: "merchant",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string; guildId?: string; payload?: { channel?: string } }) => {
        if (input.type === "npc.arrived") world.arrivals.push({ guildId: input.guildId!, channel: input.payload!.channel! });
        return undefined;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: {
      joinVoice: async (guildId: string, channelId: string) => {
        world.joins.push({ guildId, channelId });
        return true;
      },
    } as unknown as CapabilityContext["gateway"],
    personas: { guildIds } as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

const tickHour = (): BusEvent => ({ type: "tick.hour" } as BusEvent);
const route: WanderStop[] = [
  { guildId: "g1", channel: "bazaar_vc" },
  { guildId: "g1", channel: "market_square_vc" },
];

describe("presence.voice wandering (§5.1)", () => {
  it("takes the first route stop at boot without announcing (boot ping is elsewhere)", async () => {
    const world: World = { channels: { bazaar_vc_g1: "vcB", market_square_vc_g1: "vcM" }, joins: [], arrivals: [] };
    await presenceVoiceCapability(route).init!(makeCtx(world, ["g1"]));
    expect(world.joins).toEqual([{ guildId: "g1", channelId: "vcB" }]);
    expect(world.arrivals).toHaveLength(0);
  });

  it("hops to the next stop on tick.hour and wraps around, announcing each arrival", async () => {
    const world: World = { channels: { bazaar_vc_g1: "vcB", market_square_vc_g1: "vcM" }, joins: [], arrivals: [] };
    const cap = presenceVoiceCapability(route);
    await cap.init!(makeCtx(world, ["g1"])); // -> vcB
    await cap.handle!(tickHour(), makeCtx(world, ["g1"])); // -> vcM
    await cap.handle!(tickHour(), makeCtx(world, ["g1"])); // wrap -> vcB
    expect(world.joins.map((j) => j.channelId)).toEqual(["vcB", "vcM", "vcB"]);
    expect(world.arrivals).toEqual([
      { guildId: "g1", channel: "market_square_vc" },
      { guildId: "g1", channel: "bazaar_vc" },
    ]);
  });

  it("stands in the home voice channel for a guild with no route", async () => {
    const world: World = { channels: { bazaar_vc_g2: "vcB2", market_square_vc_g2: "vcM2" }, joins: [], arrivals: [] };
    await presenceVoiceCapability([]).init!(makeCtx(world, ["g2"]));
    expect(world.joins).toEqual([{ guildId: "g2", channelId: "vcB2" }]); // first location id, sorted
  });

  it("does not wander a guild with a single stop, and ignores non-tick events", async () => {
    const world: World = { channels: { bazaar_vc_g1: "vcB" }, joins: [], arrivals: [] };
    const cap = presenceVoiceCapability([{ guildId: "g1", channel: "bazaar_vc" }]);
    await cap.handle!(tickHour(), makeCtx(world, ["g1"]));
    await cap.handle!({ type: "npc.move" } as BusEvent, makeCtx(world, ["g1"]));
    expect(world.joins).toHaveLength(0);
  });
});
