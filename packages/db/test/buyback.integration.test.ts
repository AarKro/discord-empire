/**
 * Merchant buy-back (§2.5) against a REAL Postgres. Requires TEST_DATABASE_URL
 * (never DATABASE_URL — this TRUNCATEs).
 *
 * Proves sellToWorld is atomic: goods out and gold in land together with one
 * reconciling ledger row, an over-sell changes nothing, and two sells racing for
 * the same last units can't both be paid.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "../src/client.js";
import { assertMigrated } from "../src/migration-state.js";
import { sellToWorld, BUYBACK_REASON } from "../src/buyback.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

async function holdings(sql: DbHandle["sql"]) {
  const [inv] = await sql<{ qty: number }[]>`SELECT qty FROM inventories WHERE owner_id = 'p1' AND item_id = 'grain'`;
  const [bal] = await sql<{ amount: number }[]>`SELECT amount FROM balances WHERE owner_id = 'p1' AND currency = 'gold'`;
  return { grain: inv?.qty ?? 0, gold: bal?.amount ?? 0 };
}

suite("sellToWorld (§2.5)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 4 });
    await assertMigrated(h.sql);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.sql`TRUNCATE ledger, events, balances, inventories RESTART IDENTITY CASCADE`;
    await h.sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty) VALUES ('player', 'p1', 'grain', 10)`;
    await h.sql`INSERT INTO balances (owner_kind, owner_id, currency, amount) VALUES ('player', 'p1', 'gold', 100)`;
  });

  it("moves goods out and gold in, with one reconciling ledger row", async () => {
    expect(await sellToWorld(h.sql, { player: "p1", itemId: "grain", qty: 4, gold: 16 })).toEqual({ ok: true });
    expect(await holdings(h.sql)).toEqual({ grain: 6, gold: 116 });
    const rows = await h.sql<{ currency_delta: number; item_deltas: Record<string, number>; reason: string }[]>`
      SELECT currency_delta, item_deltas, reason FROM ledger
    `;
    expect(rows).toEqual([{ currency_delta: 16, item_deltas: { grain: -4 }, reason: BUYBACK_REASON }]);
  });

  it("refuses an over-sell and changes nothing", async () => {
    expect(await sellToWorld(h.sql, { player: "p1", itemId: "grain", qty: 11, gold: 44 })).toEqual({
      ok: false,
      reason: "insufficient_items",
    });
    expect(await holdings(h.sql)).toEqual({ grain: 10, gold: 100 });
    const [{ n }] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ledger`;
    expect(n).toBe(0);
  });

  it("two sells racing for the same units: exactly one is paid", async () => {
    const results = await Promise.all([
      sellToWorld(h.sql, { player: "p1", itemId: "grain", qty: 8, gold: 32 }),
      sellToWorld(h.sql, { player: "p1", itemId: "grain", qty: 8, gold: 32 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await holdings(h.sql)).toEqual({ grain: 2, gold: 132 });
  });
});
