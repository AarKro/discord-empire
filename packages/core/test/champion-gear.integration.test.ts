/**
 * Champion gear (§2.6) against a REAL Postgres: the jsonb loadout operators
 * (`||` to wear, `-` and `?` to take off) and the geared /army line.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle, assertMigrated } from "@empire/db";
import { equipGear, unequipSlot, championSummary } from "../src/capabilities/combat.js";
import type { GearCatalog } from "@empire/content-schemas";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

const GEAR: GearCatalog = {
  gear: [
    { item_id: "iron_sword", name: "Iron Sword", slot: "weapon", atk: 6, def: 0, hp: 0, recipe: { gold: 0, goods: { x: 1 }, requires: "forge" } },
    { item_id: "iron_mail", name: "Iron Mail", slot: "armor", atk: 0, def: 8, hp: 30, recipe: { gold: 0, goods: { x: 1 }, requires: "forge" } },
  ],
};

suite("champion gear (§2.6)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 2 });
    await assertMigrated(h.sql);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.sql`TRUNCATE players, units, inventories RESTART IDENTITY CASCADE`;
    await h.sql`INSERT INTO players (discord_user_id, home_guild_id) VALUES ('p1', 'g1')`;
    await h.sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty) VALUES ('player', 'p1', 'iron_sword', 1), ('player', 'p1', 'iron_mail', 1)`;
  });

  it("wears, reports and takes off gear", async () => {
    await equipGear(h.sql, "p1", GEAR, "iron_sword");
    await equipGear(h.sql, "p1", GEAR, "iron_mail");
    const [row] = await h.sql<{ equipment: Record<string, string> }[]>`SELECT equipment FROM units WHERE id = 'champion_p1'`;
    expect(row!.equipment).toEqual({ weapon: "iron_sword", armor: "iron_mail" });
    expect(await championSummary(h.sql, "p1", GEAR)).toContain("18 atk · 16 def · 90 hp");

    expect(await unequipSlot(h.sql, "p1", "weapon")).toContain("sets aside");
    expect(await unequipSlot(h.sql, "p1", "weapon")).toContain("nothing in that slot");
    const [after] = await h.sql<{ equipment: Record<string, string> }[]>`SELECT equipment FROM units WHERE id = 'champion_p1'`;
    expect(after!.equipment).toEqual({ armor: "iron_mail" });
  });

  it("flags worn gear no longer held, and doesn't count it", async () => {
    await equipGear(h.sql, "p1", GEAR, "iron_sword");
    await h.sql`UPDATE inventories SET qty = 0 WHERE item_id = 'iron_sword'`;
    const summary = await championSummary(h.sql, "p1", GEAR);
    expect(summary).toContain("12 atk");
    expect(summary).toContain("~~Iron Sword~~ (no longer held)");
  });
});
