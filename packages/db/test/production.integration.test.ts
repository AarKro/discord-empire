/**
 * Banking production (§2.4) against a REAL Postgres. Requires TEST_DATABASE_URL
 * (never DATABASE_URL — this TRUNCATEs).
 *
 * Proves collectProduction is ledgered and exactly-once: goods land in the
 * inventory with ONE reconciling ledger row per collect, the building's clock
 * advances, and an immediate second collect banks nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "../src/client.js";
import { assertMigrated } from "../src/migration-state.js";
import { collectProduction, PRODUCTION_REASON, type AccrueFn } from "../src/production.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

/** The core policy's shape, inlined (this package doesn't depend on core). */
const accrue: AccrueFn = (p, since, now) => {
  const msPerUnit = 3_600_000 / p.per_hour;
  const units = Math.floor(Math.max(0, now.getTime() - since.getTime()) / msPerUnit);
  if (units >= p.cap) return { amount: p.cap, since: now };
  return { amount: units, since: new Date(since.getTime() + units * msPerUnit) };
};

async function seedBuilding(sql: DbHandle["sql"], opts: { owner: string; blueprint: string; hoursAgo: number; status?: string }) {
  await sql`
    INSERT INTO build_queue (owner_id, plot_id, blueprint_id, status, last_collected_at)
    VALUES (${opts.owner}, 'plot', ${opts.blueprint}, ${opts.status ?? "completed"}, now() - make_interval(hours => ${opts.hoursAgo}))
  `;
}

suite("collectProduction (§2.4)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 4 });
    await assertMigrated(h.sql);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.sql`TRUNCATE ledger, events, balances, inventories, build_queue, blueprint_catalog RESTART IDENTITY CASCADE`;
    await h.sql`
      INSERT INTO blueprint_catalog (id, name, cost_gold, base_ms, produces) VALUES
        ('farm', 'Farm', 50, 1, ${JSON.stringify({ item: "grain", per_hour: 4, cap: 16 })}),
        ('forge', 'Forge', 100, 1, ${JSON.stringify({ item: "iron_tools", per_hour: 1, cap: 6 })}),
        ('barracks', 'Barracks', 60, 1, NULL)
    `;
  });

  it("banks every producing building in one ledger row, and only once", async () => {
    await seedBuilding(h.sql, { owner: "p1", blueprint: "farm", hoursAgo: 2 });
    await seedBuilding(h.sql, { owner: "p1", blueprint: "farm", hoursAgo: 1 });
    await seedBuilding(h.sql, { owner: "p1", blueprint: "forge", hoursAgo: 3 });
    await seedBuilding(h.sql, { owner: "p1", blueprint: "barracks", hoursAgo: 5 }); // produces nothing
    await seedBuilding(h.sql, { owner: "p1", blueprint: "farm", hoursAgo: 9, status: "building" }); // not finished

    const first = await collectProduction(h.sql, "p1", accrue);
    expect(first.gathered).toEqual({ grain: 12, iron_tools: 3 });
    expect(first.buildings).toHaveLength(3);

    const inv = await h.sql<{ item_id: string; qty: number }[]>`
      SELECT item_id, qty FROM inventories WHERE owner_id = 'p1' ORDER BY item_id
    `;
    expect(inv).toEqual([
      { item_id: "grain", qty: 12 },
      { item_id: "iron_tools", qty: 3 },
    ]);
    const ledger = await h.sql<{ reason: string; item_deltas: Record<string, number>; counterparty_kind: string }[]>`
      SELECT reason, item_deltas, counterparty_kind FROM ledger
    `;
    expect(ledger).toEqual([{ reason: PRODUCTION_REASON, item_deltas: { grain: 12, iron_tools: 3 }, counterparty_kind: "world" }]);

    // Straight away again: the clocks moved, so there is nothing to bank.
    const second = await collectProduction(h.sql, "p1", accrue);
    expect(second.gathered).toEqual({});
    const [{ n }] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ledger`;
    expect(n).toBe(1);
  });

  it("two collects racing bank the goods exactly once", async () => {
    await seedBuilding(h.sql, { owner: "p1", blueprint: "farm", hoursAgo: 2 });
    const [a, b] = await Promise.all([collectProduction(h.sql, "p1", accrue), collectProduction(h.sql, "p1", accrue)]);
    expect((a.gathered.grain ?? 0) + (b.gathered.grain ?? 0)).toBe(8);
    const [inv] = await h.sql<{ qty: number }[]>`SELECT qty FROM inventories WHERE owner_id = 'p1' AND item_id = 'grain'`;
    expect(inv!.qty).toBe(8);
  });

  it("caps a long absence at the store's size", async () => {
    await seedBuilding(h.sql, { owner: "p1", blueprint: "farm", hoursAgo: 48 });
    const out = await collectProduction(h.sql, "p1", accrue);
    expect(out.gathered).toEqual({ grain: 16 });
  });
});
