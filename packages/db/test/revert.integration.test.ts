/**
 * Integration suite for revertLedger (§8 revert / §9 Ops bot) against a REAL
 * Postgres. Drives a real trade through executeTrade, then reverts its ledger row
 * and asserts the derived balances/inventories return to their pre-trade state,
 * a compensating row is appended, a second revert is refused (idempotent), and a
 * bogus id reports not_found. Opt-in on TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "../src/client.js";
import { executeTrade } from "../src/trade.js";
import { revertLedger } from "../src/revert.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

const bal = (id: string, kind = "player") =>
  h.sql<{ amount: number }[]>`SELECT amount FROM balances WHERE owner_kind=${kind} AND owner_id=${id} AND currency='gold'`.then((r) => r[0]?.amount ?? 0);
const inv = (id: string, item: string, kind = "player") =>
  h.sql<{ qty: number }[]>`SELECT qty FROM inventories WHERE owner_kind=${kind} AND owner_id=${id} AND item_id=${item}`.then((r) => r[0]?.qty ?? 0);

suite("revertLedger — undo a transaction against Postgres (§8/§9)", () => {
  beforeAll(async () => { h = openDb(url!, { max: 4 }); await ensureSchema(h); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => { await h.sql`TRUNCATE ledger, events, balances, inventories RESTART IDENTITY CASCADE`; });

  async function seedTrade() {
    await h.sql`INSERT INTO balances (owner_kind, owner_id, currency, amount) VALUES ('player','p1','gold',500)`;
    await h.sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty) VALUES ('npc','merchant','sword',3)`;
    const res = await executeTrade(h.sql, {
      eventId: "evt_t1", buyer: { kind: "player", id: "p1" }, seller: { kind: "npc", id: "merchant" },
      itemId: "sword", qty: 1, price: 120,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("seed trade failed");
    return res.ledgerId;
  }

  it("reverts a trade: balances + inventories return to pre-trade, compensating row appended", async () => {
    const ledgerId = await seedTrade();
    // Post-trade: buyer 380g +1 sword; seller +120g, stock 2.
    expect(await bal("p1")).toBe(380);
    expect(await inv("p1", "sword")).toBe(1);
    expect(await bal("merchant", "npc")).toBe(120);
    expect(await inv("merchant", "sword", "npc")).toBe(2);

    const res = await revertLedger(h.sql, { ledgerId });
    expect(res.ok).toBe(true);

    // Undone: buyer back to 500g and 0 swords; seller back to 0g and 3 stock.
    expect(await bal("p1")).toBe(500);
    expect(await inv("p1", "sword")).toBe(0);
    expect(await bal("merchant", "npc")).toBe(0);
    expect(await inv("merchant", "sword", "npc")).toBe(3);

    // Append-only: original + compensating row (reason revert:<id>).
    const rows = await h.sql<{ reason: string }[]>`SELECT reason FROM ledger ORDER BY id`;
    expect(rows.map((r) => r.reason)).toEqual(["npc_trade", `revert:${ledgerId}`]);
  });

  it("refuses a second revert of the same id (idempotent)", async () => {
    const ledgerId = await seedTrade();
    expect((await revertLedger(h.sql, { ledgerId })).ok).toBe(true);
    const again = await revertLedger(h.sql, { ledgerId });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("already_reverted");
    // No third row was written by the refused revert.
    const [{ n }] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ledger`;
    expect(n).toBe(2);
    // Balances stayed at the single-revert result.
    expect(await bal("p1")).toBe(500);
  });

  it("reports not_found for an unknown ledger id", async () => {
    const res = await revertLedger(h.sql, { ledgerId: "99999" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });
});

async function ensureSchema(handle: DbHandle) {
  const { sql } = handle;
  await sql`CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, event_id text NOT NULL, type text NOT NULL, ts timestamptz NOT NULL DEFAULT now(), guild_id text, actor_kind text, actor_id text, subject_kind text, subject_id text, payload jsonb NOT NULL DEFAULT '{}', correlation_id text)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS events_event_id_uq ON events(event_id)`;
  await sql`CREATE TABLE IF NOT EXISTS ledger (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), actor_kind text NOT NULL, actor_id text NOT NULL, counterparty_kind text NOT NULL, counterparty_id text NOT NULL, currency text NOT NULL DEFAULT 'gold', currency_delta bigint NOT NULL, item_deltas jsonb NOT NULL DEFAULT '{}', reason text NOT NULL, cause_event_id bigint)`;
  await sql`CREATE TABLE IF NOT EXISTS balances (owner_kind text NOT NULL, owner_id text NOT NULL, currency text NOT NULL DEFAULT 'gold', amount bigint NOT NULL DEFAULT 0, PRIMARY KEY (owner_kind, owner_id, currency))`;
  await sql`CREATE TABLE IF NOT EXISTS inventories (owner_kind text NOT NULL, owner_id text NOT NULL, item_id text NOT NULL, qty bigint NOT NULL DEFAULT 0, PRIMARY KEY (owner_kind, owner_id, item_id))`;
}
