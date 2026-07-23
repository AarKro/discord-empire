/**
 * Unit tests for the stall presence gate (§9): clicking "Enter the stall" now
 * auto-registers the shopper and enforces requiresPresence — you can only enter
 * on the continent you actually stand on. A present player opens the stall
 * (stall.entered); one who's travelled away gets an in-fiction ephemeral refusal
 * and no stall.entered. Postgres, the gateway, and the interaction are faked.
 */
import { describe, it, expect } from "vitest";
import { stallCapability, ENTER_STALL_BUTTON } from "../src/capabilities/stall.js";
import type { ComponentInteraction } from "../src/gateway.js";
import type { CapabilityContext } from "../src/capability.js";

const SHOP = { id: "aldric", currency: "gold", items: [{ item_id: "x", name: "Trinket", base_price: 5, stock: 3 }] };

interface World {
  /** the player's current continent (players.position_guild_id) */
  position: string;
  entered: { guildId: string | null }[];
  replies: string[];
}

function makeCtx(world: World): { ctx: CapabilityContext; getHandler: () => (i: ComponentInteraction) => Promise<void> } {
  let handler: (i: ComponentInteraction) => Promise<void> = async () => {};
  const fn = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("INSERT INTO players")) return Promise.resolve([]); // already registered
    // requiresPresence: the bazaar location gates, in guild g1.
    if (q.includes("FROM locations")) return Promise.resolve([{ guild_id: "g1", district_id: null, requires_presence: true }]);
    if (q.includes("FROM players")) return Promise.resolve([{ position_guild_id: world.position, position_district_id: null }]);
    return Promise.resolve([]);
  };
  const sql = Object.assign(fn, { begin: async (cb: (tx: unknown) => unknown) => cb(sql) });
  const ctx = {
    bot: "merchant",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string; guildId?: string | null }) => {
        if (input.type === "stall.entered") world.entered.push({ guildId: input.guildId ?? null });
        return undefined;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: { onComponent: (h: (i: ComponentInteraction) => Promise<void>) => { handler = h; } } as unknown as CapabilityContext["gateway"],
    personas: {} as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
  return { ctx, getHandler: () => handler };
}

function enterClick(world: World): ComponentInteraction {
  return {
    customId: ENTER_STALL_BUTTON,
    values: [],
    userId: "p1",
    guildId: "g1",
    channelId: "c1",
    reply: async (content: string) => { world.replies.push(content); },
    update: async () => {},
  };
}

describe("stall presence gate (§9)", () => {
  it("opens the stall when the player stands on this continent", async () => {
    const world: World = { position: "g1", entered: [], replies: [] };
    const { ctx, getHandler } = makeCtx(world);
    stallCapability(SHOP).init!(ctx);
    await getHandler()(enterClick(world));
    expect(world.entered).toEqual([{ guildId: "g1" }]);
    expect(world.replies).toHaveLength(0);
  });

  it("refuses (ephemerally) when the player has travelled to another continent", async () => {
    const world: World = { position: "g2", entered: [], replies: [] };
    const { ctx, getHandler } = makeCtx(world);
    stallCapability(SHOP).init!(ctx);
    await getHandler()(enterClick(world));
    expect(world.entered).toHaveLength(0);
    expect(world.replies).toHaveLength(1);
    expect(world.replies[0]).toContain("walk from where you stand");
  });

  it("ignores clicks on other buttons", async () => {
    const world: World = { position: "g1", entered: [], replies: [] };
    const { ctx, getHandler } = makeCtx(world);
    stallCapability(SHOP).init!(ctx);
    await getHandler()({ ...enterClick(world), customId: "something:else" });
    expect(world.entered).toHaveLength(0);
    expect(world.replies).toHaveLength(0);
  });
});
