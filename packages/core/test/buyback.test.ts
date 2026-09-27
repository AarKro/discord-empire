/**
 * Merchant buy-back (§2.5): the price rule, the stall's sell menu, and the
 * `trade` capability's sell.request settlement. Postgres is faked here; the
 * atomic write itself is db/test/buyback.integration.test.ts's job.
 *
 * The properties worth pinning: the merchant never pays more than it sells for
 * (no buy-then-sell loop), a good fetches more where it isn't local (the point of
 * hauling), and the price comes from the shop — never from the click's payload.
 */
import { describe, it, expect } from "vitest";
import { buybackPrice, BUYBACK_RATE, IMPORT_PRICE_MULTIPLIER, regionalItem } from "../src/world/goods.js";
import { stallCapability, SELL_BUTTON_PREFIX } from "../src/capabilities/stall.js";
import { tradeCapability } from "../src/capabilities/trade.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";
import type { Continents, Shop } from "@empire/content-schemas";

const SHOP: Shop = {
  id: "aldric_wares",
  currency: "gold",
  items: [{ item_id: "iron_ore", name: "Iron Ore", base_price: 25, stock: 40, origin: "highlands" }],
  buys: [
    { item_id: "grain", name: "Sack of Grain", base_price: 8 },
    { item_id: "iron_ore", name: "Iron Ore", base_price: 25, origin: "highlands" },
    { item_id: "build_permit", name: "Permit", base_price: 50 }, // a hidden token must never be offered
  ],
};

const CONTINENTS: Continents = {
  continents: {
    g1: { name: "Continent One", order: 1, neighbors: ["g2"], resource_bias: "highlands" },
    g2: { name: "Continent Two", order: 2, neighbors: ["g1"], resource_bias: "harbor" },
  },
};

describe("buybackPrice (§2.5)", () => {
  const ore = SHOP.buys[1]!;
  it("pays the spread below the local price", () => {
    expect(buybackPrice(ore, "highlands")).toBe(Math.floor(25 * BUYBACK_RATE));
  });
  it("pays more for a good hauled somewhere it isn't local", () => {
    expect(buybackPrice(ore, "harbor")).toBe(Math.floor(25 * IMPORT_PRICE_MULTIPLIER * BUYBACK_RATE));
    expect(buybackPrice(ore, "harbor")).toBeGreaterThan(buybackPrice(ore, "highlands"));
  });
  it("never pays more than the merchant sells it for in the same place", () => {
    for (const region of ["highlands", "harbor"]) {
      expect(buybackPrice(ore, region)).toBeLessThan(regionalItem(SHOP.items[0]!, region).price);
    }
  });
  it("prices an untagged good the same everywhere, and never at zero", () => {
    expect(buybackPrice(SHOP.buys[0]!, "highlands")).toBe(buybackPrice(SHOP.buys[0]!, "harbor"));
    expect(buybackPrice({ item_id: "pebble", name: "Pebble", base_price: 1 }, null)).toBe(1);
  });
});

interface World {
  held: Record<string, number>;
  published: { type: string; payload?: Record<string, unknown> }[];
  sold: { itemId: string; qty: number; gold: number }[];
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("item_id = ANY(")) {
      const wanted = values[1] as string[];
      return Promise.resolve(
        Object.entries(world.held)
          .filter(([id, qty]) => qty > 0 && wanted.includes(id))
          .sort()
          .map(([item_id, qty]) => ({ item_id, qty })),
      );
    }
    if (q.includes("SELECT qty FROM inventories")) {
      const qty = world.held[String(values[1])];
      return Promise.resolve(qty === undefined ? [] : [{ qty }]);
    }
    return Promise.resolve([]);
  };
  // sellToWorld's transaction: the conditional decrement decides.
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const q = strings.join("?");
      if (q.includes("UPDATE inventories SET qty = qty -")) {
        const [qty, , item] = values as [number, string, string, number];
        if ((world.held[item] ?? 0) < qty) return Promise.resolve([]);
        world.held[item]! -= qty;
        return Promise.resolve([{ qty: world.held[item] }]);
      }
      if (q.includes("INSERT INTO ledger")) {
        const gold = values[1] as number;
        const deltas = JSON.parse(String(values[2])) as Record<string, number>;
        const [itemId, delta] = Object.entries(deltas)[0]!;
        world.sold.push({ itemId, qty: -delta, gold });
      }
      return Promise.resolve([]);
    };
    return fn(tx);
  };
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log };
  return {
    bot: "merchant",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string; payload?: Record<string, unknown> }) => {
        world.published.push(input);
        return undefined as never;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: { onComponent: () => {} } as unknown as CapabilityContext["gateway"],
    personas: { homeGuild: (g?: string | null) => g ?? "g1", has: () => true } as unknown as CapabilityContext["personas"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

const evt = (over: Partial<BusEvent>): BusEvent =>
  ({
    dbId: "1", eventId: "e1", type: "sell.request", ts: "", guildId: "g2",
    actor: { kind: "player", id: "p1" }, subject: { kind: "npc", id: "merchant" }, payload: {}, correlationId: null,
    ...over,
  }) as BusEvent;

describe("stall.sell_menu (§2.5)", () => {
  it("offers only goods the merchant buys and the player holds, priced for this continent", async () => {
    const world: World = { held: { grain: 12, iron_ore: 3, build_permit: 1, bread: 4 }, published: [], sold: [] };
    await stallCapability(SHOP, CONTINENTS).actions["stall.sell_menu"]!({}, evt({ type: "dialogue.node" }), makeCtx(world));
    const menu = world.published.find((p) => p.type === "sell.menu")!;
    const buttons = (menu.payload!.rows as { id: string; label: string }[][]).flat();
    expect(buttons.map((b) => b.id)).toEqual([
      `${SELL_BUTTON_PREFIX}grain:1`,
      `${SELL_BUTTON_PREFIX}grain:all`,
      `${SELL_BUTTON_PREFIX}iron_ore:1`,
      `${SELL_BUTTON_PREFIX}iron_ore:all`,
    ]);
    // On the harbour, highland ore is an import: 25 × 3 × 0.5 = 37 each.
    expect(buttons[2]!.label).toContain("37g");
    expect(buttons[3]!.label).toContain("111g");
  });

  it("says so when the player has nothing the merchant wants", async () => {
    const world: World = { held: { bread: 4 }, published: [], sold: [] };
    await stallCapability(SHOP, CONTINENTS).actions["stall.sell_menu"]!({}, evt({}), makeCtx(world));
    const menu = world.published.find((p) => p.type === "sell.menu")!;
    expect(menu.payload!.rows).toEqual([]);
    expect(String(menu.payload!.text)).toContain("nothing");
  });
});

describe("trade sell.request (§2.5)", () => {
  const trade = tradeCapability(SHOP, CONTINENTS);

  it("prices from the shop, not the payload, and settles the lot", async () => {
    const world: World = { held: { iron_ore: 3 }, published: [], sold: [] };
    await trade.handle!(evt({ payload: { item: "iron_ore", qty: 2, gold: 9999 } }), makeCtx(world));
    expect(world.sold).toEqual([{ itemId: "iron_ore", qty: 2, gold: 74 }]);
    expect(world.published.find((p) => p.type === "sale.completed")!.payload).toMatchObject({ qty: 2, gold: 74 });
  });

  it("sells everything held for qty: all", async () => {
    const world: World = { held: { grain: 12 }, published: [], sold: [] };
    await trade.handle!(evt({ payload: { item: "grain", qty: "all" } }), makeCtx(world));
    expect(world.sold).toEqual([{ itemId: "grain", qty: 12, gold: 48 }]);
    expect(world.held.grain).toBe(0);
  });

  it("refuses an over-sell without paying anything", async () => {
    const world: World = { held: { grain: 1 }, published: [], sold: [] };
    await trade.handle!(evt({ payload: { item: "grain", qty: 5 } }), makeCtx(world));
    expect(world.sold).toEqual([]);
    expect(world.published.map((p) => p.type)).toEqual(["sale.failed"]);
  });

  it("won't buy what it doesn't trade in", async () => {
    const world: World = { held: { bread: 4 }, published: [], sold: [] };
    await trade.handle!(evt({ payload: { item: "bread", qty: 1 } }), makeCtx(world));
    expect(world.sold).toEqual([]);
    expect(world.published.map((p) => p.type)).toEqual(["sale.failed"]);
  });

  it("ignores a sell addressed to another bot (the bus is broadcast)", async () => {
    const world: World = { held: { grain: 12 }, published: [], sold: [] };
    await trade.handle!(evt({ subject: { kind: "npc", id: "builder" }, payload: { item: "grain", qty: 1 } }), makeCtx(world));
    expect(world.published).toEqual([]);
  });
});
