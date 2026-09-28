/**
 * Crafting (§2.6) against a REAL Postgres. Requires TEST_DATABASE_URL (never
 * DATABASE_URL — this TRUNCATEs). Proves craftItem is all-or-nothing: inputs and
 * gold out, one item in, one reconciling ledger row — and any shortfall, or a
 * lost race for the last inputs, changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "../src/client.js";
import { assertMigrated } from "../src/migration-state.js";
import { craftItem, CRAFT_REASON } from "../src/craft.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

const SWORD = { player: "p1", inputs: { iron_tools: 2, wolf_pelt: 1 }, gold: 20, output: "iron_sword" };

async function state(sql: DbHandle["sql"]) {
  const inv = await sql<{ item_id: string; qty: number }[]>`SELECT item_id, qty FROM inventories WHERE owner_id = 'p1' ORDER BY item_id`;
  const [bal] = await sql<{ amount: number }[]>`SELECT amount FROM balances WHERE owner_id = 'p1'`;
  return { inv: Object.fromEntries(inv.map((r) => [r.item_id, r.qty])), gold: bal?.amount ?? 0 };
}

suite("craftItem (§2.6)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 4 });
    await assertMigrated(h.sql);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.sql`TRUNCATE ledger, events, balances, inventories RESTART IDENTITY CASCADE`;
    await h.sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty) VALUES ('player', 'p1', 'iron_tools', 3), ('player', 'p1', 'wolf_pelt', 1)`;
    await h.sql`INSERT INTO balances (owner_kind, owner_id, currency, amount) VALUES ('player', 'p1', 'gold', 50)`;
  });

  it("consumes the inputs and gold and makes the item, with one ledger row", async () => {
    expect(await craftItem(h.sql, SWORD)).toEqual({ ok: true });
    expect(await state(h.sql)).toEqual({ inv: { iron_sword: 1, iron_tools: 1, wolf_pelt: 0 }, gold: 30 });
    const rows = await h.sql<{ currency_delta: number; item_deltas: Record<string, number>; reason: string }[]>`
      SELECT currency_delta, item_deltas, reason FROM ledger
    `;
    expect(rows).toEqual([{ currency_delta: -20, item_deltas: { iron_tools: -2, wolf_pelt: -1, iron_sword: 1 }, reason: CRAFT_REASON }]);
  });

  it("a missing input rolls everything back — even inputs already taken", async () => {
    // iron_tools is decremented first, then wolf_pelt falls short.
    const res = await craftItem(h.sql, { ...SWORD, inputs: { iron_tools: 2, wolf_pelt: 2 } });
    expect(res).toEqual({ ok: false, reason: "insufficient_items", item: "wolf_pelt" });
    expect(await state(h.sql)).toEqual({ inv: { iron_tools: 3, wolf_pelt: 1 }, gold: 50 });
  });

  it("a light purse rolls everything back", async () => {
    expect(await craftItem(h.sql, { ...SWORD, gold: 51 })).toEqual({ ok: false, reason: "insufficient_funds" });
    expect(await state(h.sql)).toEqual({ inv: { iron_tools: 3, wolf_pelt: 1 }, gold: 50 });
    const [{ n }] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ledger`;
    expect(n).toBe(0);
  });

  it("two crafts racing for the last inputs make exactly one item", async () => {
    const results = await Promise.all([craftItem(h.sql, SWORD), craftItem(h.sql, SWORD)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await state(h.sql)).inv.iron_sword).toBe(1);
  });
});
