/**
 * Unit tests for presence.voice boot behaviour (§5.1): the NPC joins its home
 * voice channel (locations kind='voice', seeded by world:init) self-muted, once
 * per persona guild. Postgres and the gateway are faked; the real @discordjs/voice
 * connection is a dev-server concern — here we assert the resolve→join wiring.
 */
import { describe, it, expect } from "vitest";
import { presenceVoiceCapability } from "../src/capabilities/presence-voice.js";
import type { CapabilityContext } from "../src/capability.js";

interface World {
  /** guildId → the home voice channel id in `locations`, or null if unmapped. */
  voiceChannels: Record<string, string | null>;
  joins: { guildId: string; channelId: string }[];
}

function makeCtx(world: World, guildIds: string[]): CapabilityContext {
  const sql = (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM locations")) {
      const guildId = String(vals[0]); // WHERE guild_id = ${guildId}
      const ch = world.voiceChannels[guildId];
      return Promise.resolve(ch ? [{ channel_id: ch }] : []);
    }
    return Promise.resolve([]);
  };
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log };
  return {
    bot: "merchant",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: { publish: async () => undefined } as unknown as CapabilityContext["bus"],
    gateway: {
      joinVoice: async (guildId: string, channelId: string) => {
        world.joins.push({ guildId, channelId });
        return true;
      },
    } as unknown as CapabilityContext["gateway"],
    personas: { guildIds } as unknown as CapabilityContext["personas"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

describe("presence.voice boot join (§5.1)", () => {
  it("joins the home voice channel for each persona guild", async () => {
    const world: World = { voiceChannels: { g1: "vc1", g2: "vc2" }, joins: [] };
    await presenceVoiceCapability().init!(makeCtx(world, ["g1", "g2"]));
    expect(world.joins).toEqual([
      { guildId: "g1", channelId: "vc1" },
      { guildId: "g2", channelId: "vc2" },
    ]);
  });

  it("skips a guild whose home voice channel is not mapped (no join)", async () => {
    const world: World = { voiceChannels: { g1: null }, joins: [] };
    await presenceVoiceCapability().init!(makeCtx(world, ["g1"]));
    expect(world.joins).toHaveLength(0);
  });
});
