/**
 * /craft (§2.6) settled by `trade`: guards (known gear, a FINISHED forge) and
 * the in-fiction answers for each outcome. The atomic write is
 * db/test/craft.integration.test.ts's job; here the transaction is faked just
 * enough to succeed or fall short.
 */
import { describe, it, expect } from "vitest";
import { tradeCapability } from "../src/capabilities/trade.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";
import type { GearCatalog } from "@empire/content-schemas";

const GEAR: GearCatalog = {
  gear: [
    { item_id: "iron_sword", name: "Iron Sword", slot: "weapon", atk: 6, def: 0, hp: 0, recipe: { gold: 20, goods: { iron_tools: 2 }, requires: "forge" } },
  ],
};

interface World {
  forge: boolean;
  held: Record<string, number>;
  gold: number;
  replies: string[];
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> =>
    Promise.resolve(strings.join("?").includes("FROM build_queue") && world.forge ? [{ one: 1 }] : []);
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const q = strings.join("?");
      if (q.includes("UPDATE inventories")) {
        const [qty, , item] = values as [number, string, string];
        return Promise.resolve((world.held[item] ?? 0) >= qty ? [{ qty: 0 }] : []);
      }
      if (q.includes("UPDATE balances")) return Promise.resolve(world.gold >= (values[0] as number) ? [{ amount: 0 }] : []);
      return Promise.resolve([]);
    };
    return fn(tx);
  };
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log };
  return {
    bot: "warden",
    sql,
    bus: {
      publish: async (e: { type: string; payload?: { message?: string } }) => {
        if (e.type === "command.reply") world.replies.push(String(e.payload?.message));
      },
    },
    logger: log,
    config: {},
  } as unknown as CapabilityContext;
}

const craft = (gear: string, subject = "warden"): BusEvent =>
  ({
    dbId: "1", eventId: "e", type: "craft.requested", ts: "", guildId: "g1",
    actor: { kind: "player", id: "p1" }, subject: { kind: "npc", id: subject }, payload: { gear }, correlationId: "cmd_1",
  }) as BusEvent;

describe("trade craft.requested (§2.6)", () => {
  const trade = tradeCapability(undefined, undefined, GEAR);

  it("makes the gear at a finished forge", async () => {
    const world: World = { forge: true, held: { iron_tools: 2 }, gold: 50, replies: [] };
    await trade.handle!(craft("iron_sword"), makeCtx(world));
    expect(world.replies).toEqual([expect.stringContaining("You've made **Iron Sword**")]);
  });

  it("refuses without a finished forge, before touching anything", async () => {
    const world: World = { forge: false, held: { iron_tools: 2 }, gold: 50, replies: [] };
    await trade.handle!(craft("iron_sword"), makeCtx(world));
    expect(world.replies).toEqual([expect.stringContaining("forge work")]);
  });

  it("names the good you're short of", async () => {
    const world: World = { forge: true, held: { iron_tools: 1 }, gold: 50, replies: [] };
    await trade.handle!(craft("iron_sword"), makeCtx(world));
    expect(world.replies).toEqual([expect.stringContaining("short of iron tools — it takes 2")]);
  });

  it("says when the purse is too light", async () => {
    const world: World = { forge: true, held: { iron_tools: 2 }, gold: 5, replies: [] };
    await trade.handle!(craft("iron_sword"), makeCtx(world));
    expect(world.replies).toEqual([expect.stringContaining("costs 20 gold")]);
  });

  it("won't make what isn't in the catalog, and ignores other bots' crafts", async () => {
    const world: World = { forge: true, held: {}, gold: 0, replies: [] };
    await trade.handle!(craft("excalibur"), makeCtx(world));
    await trade.handle!(craft("iron_sword", "builder"), makeCtx(world));
    expect(world.replies).toEqual(["I don't know how to make that."]);
  });
});
