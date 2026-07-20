/**
 * Unit tests for notify's delivery path (§5.9). Postgres and the gateway are
 * faked; we assert notify posts a requested message straight to the player's
 * land channel and skips-with-log when no channel exists (the fallback contract).
 * notify carries no domain knowledge — the message text arrives on the event.
 */
import { describe, it, expect } from "vitest";
import { notifyCapability } from "../src/capabilities/notify.js";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";

interface World {
  channel: string | null; // land_plots.text_channel_id
  prefs: { target: "land" | "dm"; dm: boolean } | null;
  sends: { channelId: string; content: string }[];
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("notification_prefs")) return Promise.resolve(world.prefs ? [{ notification_prefs: world.prefs }] : []);
    if (q.includes("FROM land_plots")) return Promise.resolve([{ text_channel_id: world.channel }]);
    return Promise.resolve([]);
  };
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log };
  return {
    bot: "builder",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: { publish: async () => undefined } as unknown as CapabilityContext["bus"],
    gateway: {
      sendToChannel: async (channelId: string, content: string) => {
        world.sends.push({ channelId, content });
        return "m1";
      },
    } as unknown as CapabilityContext["gateway"],
    personas: { guildIds: ["g1"] } as unknown as CapabilityContext["personas"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

function notifyRequested(over: Partial<BusEvent> = {}): BusEvent {
  return {
    dbId: "1", eventId: "e1", ts: "", guildId: "g1",
    type: "notify.requested",
    actor: { kind: "player", id: "u1" },
    subject: { kind: "npc", id: "builder" },
    payload: { message: "Your farm is complete!" },
    ...over,
  } as BusEvent;
}

describe("notify delivery (§5.9)", () => {
  it("posts the requested message to the player's land channel", async () => {
    const world: World = { channel: "chan1", prefs: null, sends: [] };
    await notifyCapability().handle!(notifyRequested(), makeCtx(world));
    expect(world.sends).toHaveLength(1);
    expect(world.sends[0]!.channelId).toBe("chan1");
    expect(world.sends[0]!.content).toBe("Your farm is complete!");
  });

  it("skips with no send when the plot has no land channel", async () => {
    const world: World = { channel: null, prefs: null, sends: [] };
    await notifyCapability().handle!(notifyRequested(), makeCtx(world));
    expect(world.sends).toHaveLength(0);
  });

  it("falls back to the land channel for a DM-opted-in player (DM not wired yet)", async () => {
    const world: World = { channel: "chan1", prefs: { target: "dm", dm: true }, sends: [] };
    await notifyCapability().handle!(notifyRequested(), makeCtx(world));
    expect(world.sends).toHaveLength(1);
    expect(world.sends[0]!.channelId).toBe("chan1");
  });

  it("ignores notifications addressed to another bot (broadcast bus)", async () => {
    const world: World = { channel: "chan1", prefs: null, sends: [] };
    await notifyCapability().handle!(notifyRequested({ subject: { kind: "npc", id: "merchant" } }), makeCtx(world));
    expect(world.sends).toHaveLength(0);
  });

  it("ignores events other than notify.requested", async () => {
    const world: World = { channel: "chan1", prefs: null, sends: [] };
    await notifyCapability().handle!(notifyRequested({ type: "build.completed" }), makeCtx(world));
    expect(world.sends).toHaveLength(0);
  });
});
