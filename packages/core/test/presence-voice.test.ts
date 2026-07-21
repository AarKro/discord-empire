/**
 * Unit tests for presence.voice (§5.1): at boot the NPC takes its first route
 * stop (no announce — the boot ping is elsewhere); a routeless guild just stands
 * in its home voice channel. Wandering itself is now workflow-driven — a workflow
 * composes the npc.move_to verb, tested here directly (resolve→join→announce).
 * Postgres and the gateway are faked — the real @discordjs/voice connection is a
 * dev-server concern; here we assert the resolve→join→announce wiring.
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
    personas: {
      guildIds,
      homeGuild: (guildId?: string) => guildId ?? guildIds[0]!,
    } as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

const route: WanderStop[] = [
  { guildId: "g1", channel: "bazaar_vc" },
  { guildId: "g1", channel: "market_square_vc" },
];

describe("presence.voice (§5.1)", () => {
  it("takes the first route stop at boot without announcing (boot ping is elsewhere)", async () => {
    const world: World = { channels: { bazaar_vc_g1: "vcB", market_square_vc_g1: "vcM" }, joins: [], arrivals: [] };
    await presenceVoiceCapability(route).init!(makeCtx(world, ["g1"]));
    expect(world.joins).toEqual([{ guildId: "g1", channelId: "vcB" }]);
    expect(world.arrivals).toHaveLength(0);
  });

  it("stands in the home voice channel for a guild with no route", async () => {
    const world: World = { channels: { bazaar_vc_g2: "vcB2", market_square_vc_g2: "vcM2" }, joins: [], arrivals: [] };
    await presenceVoiceCapability([]).init!(makeCtx(world, ["g2"]));
    expect(world.joins).toEqual([{ guildId: "g2", channelId: "vcB2" }]); // first location id, sorted
  });

  it("npc.move_to (the workflow-driven verb) joins the stop and announces arrival", async () => {
    const world: World = { channels: { market_square_vc_g1: "vcM" }, joins: [], arrivals: [] };
    const cap = presenceVoiceCapability(route);
    const ctx = makeCtx(world, ["g1"]);
    await cap.actions["npc.move_to"]!({ channel: "market_square_vc" }, { guildId: "g1" } as BusEvent, ctx);
    expect(world.joins).toEqual([{ guildId: "g1", channelId: "vcM" }]);
    expect(world.arrivals).toEqual([{ guildId: "g1", channel: "market_square_vc" }]);
  });
});
