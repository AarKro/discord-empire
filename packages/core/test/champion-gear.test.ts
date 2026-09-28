/**
 * Champion gear (§2.6): the stat rule, and /equip · /unequip's guards. Both
 * commands only record a choice (no ledger), so they're tested against a small
 * fake of the rows they read and write.
 */
import { describe, it, expect } from "vitest";
import { championWithGear, championStats } from "../src/combat/types.js";
import { equipGear, unequipSlot } from "../src/capabilities/combat.js";
import type { Sql } from "@empire/db";
import type { GearCatalog } from "@empire/content-schemas";

const GEAR: GearCatalog = {
  gear: [
    { item_id: "iron_sword", name: "Iron Sword", slot: "weapon", atk: 6, def: 0, hp: 0, recipe: { gold: 0, goods: { x: 1 }, requires: "forge" } },
    { item_id: "rune_blade", name: "Rune Blade", slot: "weapon", atk: 14, def: 0, hp: 0, recipe: { gold: 0, goods: { x: 1 }, requires: "forge" } },
  ],
};

describe("championWithGear", () => {
  it("adds every piece's bonus to the tier base", () => {
    expect(championWithGear(championStats(1), [{ atk: 6, def: 0, hp: 0 }, { atk: 0, def: 8, hp: 30 }])).toEqual({ atk: 18, def: 16, hp: 90 });
  });
  it("is the base alone with nothing worn, and doesn't mutate it", () => {
    const base = championStats(2);
    expect(championWithGear(base, [])).toEqual(base);
    expect(championWithGear(base, [{ atk: 1, def: 1, hp: 1 }])).not.toBe(base);
  });
});

interface Row {
  held: string[];
  equipment: Record<string, string>;
}

function fakeSql(row: Row): Sql {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("SELECT qty FROM inventories")) return Promise.resolve(row.held.includes(String(values[1])) ? [{ qty: 1 }] : []);
    if (q.includes("SELECT tier FROM players")) return Promise.resolve([{ tier: 1 }]);
    if (q.includes("INSERT INTO units")) return Promise.resolve([{ id: "champion_p1", equipment: { ...row.equipment } }]);
    if (q.includes("UPDATE units SET equipment = equipment ||")) {
      Object.assign(row.equipment, JSON.parse(String(values[0])));
      return Promise.resolve([]);
    }
    if (q.includes("UPDATE units SET equipment = equipment -")) {
      const slot = String(values[0]);
      if (!(slot in row.equipment)) return Promise.resolve([]);
      delete row.equipment[slot];
      return Promise.resolve([{ id: "champion_p1" }]);
    }
    return Promise.resolve([]);
  };
  return sql as unknown as Sql;
}

describe("/equip · /unequip (§2.6)", () => {
  it("wears held gear in its slot, and says what it replaced", async () => {
    const row: Row = { held: ["iron_sword", "rune_blade"], equipment: {} };
    expect(await equipGear(fakeSql(row), "p1", GEAR, "iron_sword")).toContain("takes up the **Iron Sword**");
    expect(row.equipment).toEqual({ weapon: "iron_sword" });
    expect(await equipGear(fakeSql(row), "p1", GEAR, "rune_blade")).toContain("in place of the Iron Sword");
    expect(row.equipment).toEqual({ weapon: "rune_blade" });
  });

  it("refuses gear you don't hold, or that isn't gear", async () => {
    const row: Row = { held: [], equipment: {} };
    expect(await equipGear(fakeSql(row), "p1", GEAR, "iron_sword")).toContain("You don't hold the Iron Sword");
    expect(await equipGear(fakeSql(row), "p1", GEAR, "bread")).toContain("not something a champion can wear");
    expect(row.equipment).toEqual({});
  });

  it("empties a slot, and says when it was already empty or isn't a slot", async () => {
    const row: Row = { held: [], equipment: { weapon: "iron_sword" } };
    expect(await unequipSlot(fakeSql(row), "p1", "weapon")).toContain("sets aside");
    expect(await unequipSlot(fakeSql(row), "p1", "weapon")).toContain("nothing in that slot");
    expect(await unequipSlot(fakeSql(row), "p1", "helmet")).toContain("Name a slot");
  });
});
