/**
 * The single integration suite (tech spec §Testing): the ledger's atomic trade
 * contract against a REAL Postgres. No mocking. Requires DATABASE_URL.
 *
 *   pnpm test:integration                # after `docker compose up -d postgres`
 *
 * Covers the mandated concurrency race: two buyers, one item in stock, exactly
 * one succeeds, and the ledger + derived balances reconcile.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "../src/client.js";
import { executeTrade } from "../src/trade.js";

// DELIBERATELY not DATABASE_URL: these suites TRUNCATE shared tables, so they
// must never point at the dev-world database (empire_test locally, see infra/).
const url = process.env.TEST_DATABASE_URL;

// The suite is skipped when no test database is provided (plain unit runs).
const suite = url ? describe : describe.skip;

let h: DbHandle;

async function reset(sql: DbHandle["sql"]) {
  await sql`TRUNCATE ledger, events, balances, inventories RESTART IDENTITY CASCADE`;
}

async function seed(
  sql: DbHandle["sql"],
  opts: { buyers: { id: string; gold: number }[]; sellerStock: number; price: number },
) {
  for (const b of opts.buyers) {
    await sql`INSERT INTO balances (owner_kind, owner_id, currency, amount)
              VALUES ('player', ${b.id}, 'gold', ${b.gold})`;
  }
  await sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
            VALUES ('npc', 'merchant', 'arcane_forge', ${opts.sellerStock})`;
}

suite("ledger atomic trade contract", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 10 });
    // Ensure the schema exists. In CI drizzle-kit migrate runs first; locally we
    // create the minimal tables the suite touches if they are absent.
    await ensureSchema(h);
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await reset(h.sql);
  });

  it("commits a valid trade, appends ledger + event rows, moves balances", async () => {
    await seed(h.sql, { buyers: [{ id: "p1", gold: 500 }], sellerStock: 3, price: 120 });

    const res = await executeTrade(h.sql, {
      eventId: "evt_ok_1",
      buyer: { kind: "player", id: "p1" },
      seller: { kind: "npc", id: "merchant" },
      itemId: "arcane_forge",
      qty: 1,
      price: 120,
    });

    expect(res.ok).toBe(true);

    const [buyerBal] = await h.sql`SELECT amount FROM balances WHERE owner_id='p1'`;
    const [sellerBal] = await h.sql`SELECT amount FROM balances WHERE owner_id='merchant'`;
    const [buyerInv] = await h.sql`SELECT qty FROM inventories WHERE owner_id='p1' AND item_id='arcane_forge'`;
    const [stock] = await h.sql`SELECT qty FROM inventories WHERE owner_id='merchant' AND item_id='arcane_forge'`;
    const ledgerRows = await h.sql`SELECT * FROM ledger`;
    const eventRows = await h.sql`SELECT * FROM events WHERE type='trade.completed'`;

    expect(buyerBal!.amount).toBe(380);
    expect(sellerBal!.amount).toBe(120);
    expect(buyerInv!.qty).toBe(1);
    expect(stock!.qty).toBe(2);
    expect(ledgerRows.length).toBe(1);
    expect(eventRows.length).toBe(1);
  });

  it("rejects insufficient funds and writes nothing", async () => {
    await seed(h.sql, { buyers: [{ id: "poor", gold: 10 }], sellerStock: 1, price: 120 });

    const res = await executeTrade(h.sql, {
      eventId: "evt_poor",
      buyer: { kind: "player", id: "poor" },
      seller: { kind: "npc", id: "merchant" },
      itemId: "arcane_forge",
      qty: 1,
      price: 120,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("insufficient_funds");

    const [stock] = await h.sql`SELECT qty FROM inventories WHERE owner_id='merchant'`;
    const ledgerRows = await h.sql`SELECT * FROM ledger`;
    expect(stock!.qty).toBe(1); // untouched — full rollback
    expect(ledgerRows.length).toBe(0);
  });

  it("race: two buyers, one item — exactly one wins and balances reconcile", async () => {
    await seed(h.sql, {
      buyers: [
        { id: "alice", gold: 500 },
        { id: "bob", gold: 500 },
      ],
      sellerStock: 1,
      price: 120,
    });

    // Fire both trades concurrently against the single last unit.
    const [rA, rB] = await Promise.all([
      executeTrade(h.sql, {
        eventId: "evt_alice",
        buyer: { kind: "player", id: "alice" },
        seller: { kind: "npc", id: "merchant" },
        itemId: "arcane_forge",
        qty: 1,
        price: 120,
      }),
      executeTrade(h.sql, {
        eventId: "evt_bob",
        buyer: { kind: "player", id: "bob" },
        seller: { kind: "npc", id: "merchant" },
        itemId: "arcane_forge",
        qty: 1,
        price: 120,
      }),
    ]);

    const winners = [rA, rB].filter((r) => r.ok);
    const losers = [rA, rB].filter((r) => !r.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    if (!losers[0]!.ok) expect(losers[0]!.reason).toBe("out_of_stock");

    // Ledger reconciliation: exactly one trade recorded; stock at 0; the losing
    // buyer's gold is fully intact; the winning buyer paid exactly the price.
    const [stock] = await h.sql`SELECT qty FROM inventories WHERE owner_id='merchant'`;
    const ledgerRows = await h.sql`SELECT * FROM ledger`;
    const [sellerBal] = await h.sql`SELECT amount FROM balances WHERE owner_id='merchant'`;
    expect(stock!.qty).toBe(0);
    expect(ledgerRows.length).toBe(1);
    expect(sellerBal!.amount).toBe(120);

    const balances = await h.sql`SELECT owner_id, amount FROM balances WHERE owner_kind='player' ORDER BY owner_id`;
    const paid = balances.filter((b) => b.amount === 380).length;
    const untouched = balances.filter((b) => b.amount === 500).length;
    expect(paid).toBe(1);
    expect(untouched).toBe(1);
  });
});

/** Create only the tables this suite exercises, if migrations haven't run. */
async function ensureSchema(handle: DbHandle) {
  const { sql } = handle;
  await sql`CREATE TABLE IF NOT EXISTS events (
    id bigserial PRIMARY KEY,
    event_id text NOT NULL,
    type text NOT NULL,
    ts timestamptz NOT NULL DEFAULT now(),
    guild_id text,
    actor_kind text, actor_id text,
    subject_kind text, subject_id text,
    payload jsonb NOT NULL DEFAULT '{}',
    correlation_id text
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS events_event_id_uq ON events(event_id)`;
  await sql`CREATE TABLE IF NOT EXISTS ledger (
    id bigserial PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    actor_kind text NOT NULL, actor_id text NOT NULL,
    counterparty_kind text NOT NULL, counterparty_id text NOT NULL,
    currency text NOT NULL DEFAULT 'gold',
    currency_delta bigint NOT NULL,
    item_deltas jsonb NOT NULL DEFAULT '{}',
    reason text NOT NULL,
    cause_event_id bigint
  )`;
  await sql`CREATE TABLE IF NOT EXISTS balances (
    owner_kind text NOT NULL, owner_id text NOT NULL,
    currency text NOT NULL DEFAULT 'gold',
    amount bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_kind, owner_id, currency)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS inventories (
    owner_kind text NOT NULL, owner_id text NOT NULL,
    item_id text NOT NULL,
    qty bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_kind, owner_id, item_id)
  )`;
}
