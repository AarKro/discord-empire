/**
 * Unit tests for the stall's regional view (§2.5). The same shop file renders
 * differently on each continent: local wares deep and at base price, foreign
 * ones dear, scarce and marked as the merchant's own travels.
 *
 * The property worth pinning is that the stall reads THIS continent's purse.
 * Before local goods, every persona shared one `merchant` inventory row, so a
 * sale in the Thornwild silently drained the Highlands' shelf. A regression
 * would be invisible in play until two continents disagreed about stock.
 */
import { describe, it, expect } from "vitest";
import { stallCapability } from "../src/capabilities/stall.js";
import { IMPORT_PRICE_MULTIPLIER, IMPORT_STOCK } from "../src/world/goods.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";
import type { Continents, Shop } from "@empire/content-schemas";

const SHOP: Shop = {
  id: "aldric_wares",
  currency: "gold",
  items: [
    { item_id: "bread", name: "Loaf of Bread", base_price: 5, stock: 100 },
    { item_id: "iron_ore", name: "Iron Ore", base_price: 25, stock: 40, origin: "highlands" },
    { item_id: "heartwood", name: "Heartwood Timber", base_price: 30, stock: 35, origin: "wildwood" },
  ],
};

const CONTINENTS: Continents = {
  continents: {
    g1: { name: "Continent One", order: 1, neighbors: ["g3"], resource_bias: "highlands" },
    g3: { name: "The Thornwild", order: 3, neighbors: ["g1"], resource_bias: "wildwood" },
  },
};

interface World {
  /** Rows the inventory read returns, and the owner it was asked for. */
  stock: { item_id: string; qty: number }[];
  askedOwner: string | null;
  published: { type: string; payload?: Record<string, unknown> }[];
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM inventories")) {
      world.askedOwner = String(values[0]);
      return Promise.resolve(world.stock);
    }
    return Promise.resolve([]);
  };
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(sql);
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
    personas: {
      guildIds: ["g1", "g3"],
      homeGuild: (g?: string | null) => g ?? "g1",
      has: () => true,
      resolve: () => ({ nickname: "Aldric" }),
    } as unknown as CapabilityContext["personas"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

const cap = stallCapability(SHOP, CONTINENTS);

/** Render the stall on `guildId` and return the embed description it drew. */
async function render(world: World, guildId: string): Promise<string> {
  const ctx = makeCtx(world);
  const evt = { type: "stall.open", guildId } as unknown as BusEvent;
  await cap.actions["stall.open"]!({}, evt, ctx);
  const rendered = world.published.find((p) => p.type === "stall.rendered");
  return JSON.stringify((rendered?.payload as { embed?: unknown })?.embed ?? {});
}

function world(stock: { item_id: string; qty: number }[] = []): World {
  return { stock, askedOwner: null, published: [] };
}

describe("the stall's regional view (§2.5 supply is not global)", () => {
  it("reads THIS continent's purse, not the bare bot id", async () => {
    const w = world();
    await render(w, "g3");
    expect(w.askedOwner).toBe("merchant@g3");
  });

  it("gives each continent a different purse", async () => {
    const one = world();
    const three = world();
    await render(one, "g1");
    await render(three, "g3");
    expect(one.askedOwner).not.toBe(three.askedOwner);
  });

  it("sells a local ware at base price with no import marker", async () => {
    const drawn = await render(world(), "g1");
    expect(drawn).toContain("Iron Ore");
    expect(drawn).toContain("25 gold");
    expect(drawn).not.toContain("✦ **Iron Ore**");
  });

  it("sells the same ware abroad dear, scarce and marked as a traveller's curio", async () => {
    const drawn = await render(world(), "g3");
    expect(drawn).toContain(`✦ **Iron Ore** — ${25 * IMPORT_PRICE_MULTIPLIER} gold`);
    expect(drawn).toContain("from my own travels");
    expect(drawn).toContain(`only ${IMPORT_STOCK} left`);
  });

  it("swaps which wares are local as you cross the ring", async () => {
    const highlands = await render(world(), "g1");
    const thornwild = await render(world(), "g3");
    // Heartwood is the mirror of iron ore: cheap at home, a curio abroad.
    expect(highlands).toContain("✦ **Heartwood Timber**");
    expect(thornwild).not.toContain("✦ **Heartwood Timber**");
  });

  it("sells an untagged ware identically on both continents", async () => {
    // Bread is bread — and this is what keeps progression-critical wares from
    // being gated behind a caravan.
    expect(await render(world(), "g1")).toContain("**Loaf of Bread** — 5 gold");
    expect(await render(world(), "g3")).toContain("**Loaf of Bread** — 5 gold");
  });

  it("prefers live DB stock over the content's seed value", async () => {
    const drawn = await render(world([{ item_id: "iron_ore", qty: 2 }]), "g1");
    expect(drawn).toContain("only 2 left!");
  });
});
