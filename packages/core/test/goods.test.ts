/**
 * Unit tests for §2.5's local trade goods — the regional view of a shop item and
 * the per-continent commerce identity.
 *
 * Both are pure, and both are read from three places that must agree: world-init
 * seeds stock with them, the stall renders prices with them, and `trade` charges
 * with them. A divergence would show up as a ware advertised at one price and
 * billed at another, so the branches are pinned here rather than inferred from a
 * capability test.
 */
import { describe, it, expect } from "vitest";
import { regionOf, regionalItem, IMPORT_PRICE_MULTIPLIER, IMPORT_STOCK } from "../src/world/goods.js";
import { npcAt } from "../src/world/npc-identity.js";
import type { Continents, ShopItem } from "@empire/content-schemas";

const CONTINENTS: Continents = {
  continents: {
    g1: { name: "Continent One", order: 1, neighbors: ["g2"], resource_bias: "highlands" },
    g2: { name: "The Thornwild", order: 2, neighbors: ["g1"], resource_bias: "wildwood" },
    g3: { name: "No Bias", order: 3, neighbors: [] },
  },
};

const ORE: ShopItem = { item_id: "iron_ore", name: "Iron Ore", base_price: 25, stock: 40, origin: "highlands" };
const BREAD: ShopItem = { item_id: "bread", name: "Loaf of Bread", base_price: 5, stock: 100 };
const FORGE: ShopItem = {
  item_id: "blueprint_arcane_forge",
  name: "Blueprint: Arcane Forge",
  base_price: 120,
  stock: 1,
  floor_price: 90,
  origin: "highlands",
};

describe("regionOf (§2.5 origin named by resource_bias)", () => {
  it("reads the continent's resource bias", () => {
    expect(regionOf(CONTINENTS, "g1")).toBe("highlands");
    expect(regionOf(CONTINENTS, "g2")).toBe("wildwood");
  });

  it("is null for an unknown guild, a biasless continent, or no guild at all", () => {
    expect(regionOf(CONTINENTS, "nope")).toBeNull();
    expect(regionOf(CONTINENTS, "g3")).toBeNull();
    expect(regionOf(CONTINENTS, null)).toBeNull();
  });
});

describe("regionalItem (§2.5 supply is not global)", () => {
  it("sells an untagged ware identically everywhere", () => {
    // Bread is bread — and anything progression-critical stays untagged too, so
    // a player can't be gated behind a caravan they can't yet afford.
    for (const region of ["highlands", "wildwood", null]) {
      expect(regionalItem(BREAD, region)).toEqual({ price: 5, floorPrice: undefined, stock: 100, imported: false });
    }
  });

  it("sells a local ware deep and at base price", () => {
    expect(regionalItem(ORE, "highlands")).toEqual({ price: 25, floorPrice: undefined, stock: 40, imported: false });
  });

  it("sells a foreign ware dear and scarce, flagged as imported", () => {
    expect(regionalItem(ORE, "wildwood")).toEqual({
      price: 25 * IMPORT_PRICE_MULTIPLIER,
      floorPrice: undefined,
      stock: IMPORT_STOCK,
      imported: true,
    });
  });

  it("scales the hidden haggle floor with the import premium", () => {
    // Otherwise haggling an import down would reach its HOME floor and quietly
    // undo the markup — the curio would become the cheap way to buy it.
    const abroad = regionalItem(FORGE, "wildwood");
    expect(abroad.price).toBe(360);
    expect(abroad.floorPrice).toBe(270);
    expect(regionalItem(FORGE, "highlands").floorPrice).toBe(90);
  });

  it("treats a regionless guild as nothing being local", () => {
    // The safe direction: it can only make a ware look imported, never conjure
    // cheap stock out of an unmapped guild.
    expect(regionalItem(ORE, null).imported).toBe(true);
  });

  it("keeps the import strictly worse than travelling for it", () => {
    const home = regionalItem(ORE, "highlands");
    const abroad = regionalItem(ORE, "wildwood");
    expect(abroad.price).toBeGreaterThan(home.price);
    expect(abroad.stock).toBeLessThan(home.stock);
  });
});

describe("npcAt (§2.5 commerce identity forks per continent)", () => {
  it("qualifies a bot id by guild", () => {
    expect(npcAt("merchant", "g1")).toBe("merchant@g1");
  });

  it("gives different continents different purses", () => {
    expect(npcAt("merchant", "g1")).not.toBe(npcAt("merchant", "g2"));
  });

  it("avoids the colon that component custom-ids split on", () => {
    // `crv:buy:<dispatch>:<item>` is parsed by field; an id carrying a colon
    // would be a split waiting to go wrong.
    expect(npcAt("merchant", "g1")).not.toContain(":");
  });
});
