/**
 * `restockShop` against real Postgres. Restocking is the one path that creates
 * goods from nothing, so the property under test is invariant #2: an NPC's shelf
 * must stay DERIVABLE from the append-only ledger. A top-up that moved stock
 * without a matching row would break "where did these goods come from" forever,
 * and nothing else in the system would notice.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "../src/client.js";
import { assertMigrated } from "../src/migration-state.js";
import { restockShop, RESTOCK_REASON } from "../src/restock.js";

// Never DATABASE_URL: this suite truncates shared tables (see ledger suite).
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

const NPC = "merchant@g1";

const qty = async (item: string) =>
  (await h.sql<{ qty: number }[]>`
    SELECT qty FROM inventories WHERE owner_kind = 'npc' AND owner_id = ${NPC} AND item_id = ${item}
  `)[0]?.qty ?? 0;

const restockRows = () =>
  h.sql<{ item_deltas: Record<string, number>; actor_id: string; counterparty_id: string; currency_delta: number }[]>`
    SELECT item_deltas, actor_id, counterparty_id, currency_delta FROM ledger WHERE reason = ${RESTOCK_REASON} ORDER BY id
  `;

suite("restockShop — stock stays ledger-derivable (§8)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 4 });
    await assertMigrated(h.sql);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.sql`TRUNCATE inventories, ledger, npcs RESTART IDENTITY CASCADE`;
  });

  it("creates the shelf row and the row that explains it", async () => {
    await restockShop(h.sql, { npcId: NPC, itemId: "iron_ore", qty: 10 });

    expect(await qty("iron_ore")).toBe(10);
    const rows = await restockRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.item_deltas).toEqual({ iron_ore: 10 });
    // Goods enter the world FROM the world, exactly as grantReward's grants do.
    expect(rows[0]!.actor_id).toBe(NPC);
    expect(rows[0]!.counterparty_id).toBe("world");
    // A restock is not a purchase: no gold moves.
    expect(Number(rows[0]!.currency_delta)).toBe(0);
  });

  it("accumulates onto an existing shelf and reconciles against the ledger", async () => {
    await restockShop(h.sql, { npcId: NPC, itemId: "iron_ore", qty: 10 });
    await restockShop(h.sql, { npcId: NPC, itemId: "iron_ore", qty: 7 });

    const rows = await restockRows();
    const ledgered = rows.reduce((sum, r) => sum + (r.item_deltas["iron_ore"] ?? 0), 0);
    // The derived cache and its source of truth must agree — that is the invariant.
    expect(await qty("iron_ore")).toBe(17);
    expect(ledgered).toBe(17);
  });

  it("keeps each ware's shelf separate", async () => {
    await restockShop(h.sql, { npcId: NPC, itemId: "iron_ore", qty: 4 });
    await restockShop(h.sql, { npcId: NPC, itemId: "bread", qty: 9 });

    expect(await qty("iron_ore")).toBe(4);
    expect(await qty("bread")).toBe(9);
  });

  it("is a no-op for a non-positive qty, writing no ledger row", async () => {
    // The sweep hands over a computed amount; making zero harmless here is what
    // lets an idle world produce no rows at all.
    await restockShop(h.sql, { npcId: NPC, itemId: "iron_ore", qty: 0 });
    await restockShop(h.sql, { npcId: NPC, itemId: "iron_ore", qty: -5 });

    expect(await qty("iron_ore")).toBe(0);
    expect(await restockRows()).toHaveLength(0);
  });
});
