/**
 * Auction close settlement against a REAL Postgres (tech spec §Testing). No
 * mocking. Requires TEST_DATABASE_URL (never DATABASE_URL — this TRUNCATEs).
 *
 * Proves settleAuction is atomic + idempotent: a WON auction delivers item→winner
 * and gold→lister with reconciling ledger rows; an UNSOLD auction returns the item;
 * a re-fired close (tick-service publishes auction.closed every tick until the row
 * leaves 'open') is a no-op. Also guards the price=0 listing-escrow assumption.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "../src/client.js";
import { executeTrade } from "../src/trade.js";
import { settleAuction } from "../src/auction.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

async function reset(sql: DbHandle["sql"]) {
  await sql`TRUNCATE ledger, events, balances, inventories, offers, bids RESTART IDENTITY CASCADE`;
}

/** Seed an open auction with its item (and, for a live high bid, its gold) escrowed. */
async function seedAuction(
  sql: DbHandle["sql"],
  opts: { id: string; lister: string; item: string; qty: number; price: number; winner?: string },
) {
  await sql`
    INSERT INTO offers (id, kind, maker_kind, maker_id, item_id, qty, price, side, status, taker_id, guild_id, expires_at)
    VALUES (${opts.id}, 'auction', 'player', ${opts.lister}, ${opts.item}, ${opts.qty}, ${opts.price},
            'sell', 'open', ${opts.winner ?? null}, 'g1', now() - interval '1 minute')
  `;
  // Listed item escrowed under the auction Party from listing time.
  await sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty) VALUES ('auction', ${opts.id}, ${opts.item}, ${opts.qty})`;
  if (opts.winner) {
    // Winning bid's gold sits in the auction Party's balance; the held bid row.
    await sql`INSERT INTO balances (owner_kind, owner_id, currency, amount) VALUES ('auction', ${opts.id}, 'gold', ${opts.price})`;
    await sql`INSERT INTO bids (id, offer_id, bidder_id, amount, status) VALUES (${`bid_${opts.id}`}, ${opts.id}, ${opts.winner}, ${opts.price}, 'held')`;
  }
}

suite("settleAuction close settlement", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 10 });
    await ensureSchema(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await reset(h.sql);
  });

  it("WON: delivers item to winner, pays gold to lister, reconciles", async () => {
    await seedAuction(h.sql, { id: "auc_w", lister: "lister", item: "sword", qty: 1, price: 200, winner: "winner" });

    const res = await settleAuction(h.sql, { offerId: "auc_w", eventId: "evt_auc_w" });
    expect(res.ok && res.outcome).toBe("won");

    const [offer] = await h.sql`SELECT status FROM offers WHERE id='auc_w'`;
    const [winnerInv] = await h.sql`SELECT qty FROM inventories WHERE owner_kind='player' AND owner_id='winner' AND item_id='sword'`;
    const [listerBal] = await h.sql`SELECT amount FROM balances WHERE owner_kind='player' AND owner_id='lister'`;
    const escrowInv = await h.sql`SELECT qty FROM inventories WHERE owner_kind='auction' AND owner_id='auc_w' AND item_id='sword'`;
    const [escrowBal] = await h.sql`SELECT amount FROM balances WHERE owner_kind='auction' AND owner_id='auc_w'`;
    const [bid] = await h.sql`SELECT status FROM bids WHERE offer_id='auc_w'`;
    const events = await h.sql`SELECT * FROM events WHERE type='trade.completed'`;
    const ledgerRows = await h.sql`SELECT reason FROM ledger ORDER BY id`;

    expect(offer!.status).toBe("filled");
    expect(winnerInv!.qty).toBe(1);
    expect(listerBal!.amount).toBe(200);
    expect(escrowInv[0]?.qty ?? 0).toBe(0); // item left escrow
    expect(escrowBal!.amount).toBe(0); // gold left escrow
    expect(bid!.status).toBe("won");
    expect(events.length).toBe(1);
    expect(ledgerRows.map((r) => r.reason)).toEqual(["auction_won", "auction_payout"]);
  });

  it("UNSOLD: no qualifying bid returns the item to the lister", async () => {
    await seedAuction(h.sql, { id: "auc_u", lister: "lister", item: "shield", qty: 2, price: 500 }); // no winner

    const res = await settleAuction(h.sql, { offerId: "auc_u", eventId: "evt_auc_u" });
    expect(res.ok && res.outcome).toBe("unsold");

    const [offer] = await h.sql`SELECT status FROM offers WHERE id='auc_u'`;
    const [listerInv] = await h.sql`SELECT qty FROM inventories WHERE owner_kind='player' AND owner_id='lister' AND item_id='shield'`;
    const escrowInv = await h.sql`SELECT qty FROM inventories WHERE owner_kind='auction' AND owner_id='auc_u' AND item_id='shield'`;
    const events = await h.sql`SELECT * FROM events WHERE type='trade.completed'`;
    const ledgerRows = await h.sql`SELECT reason FROM ledger`;

    expect(offer!.status).toBe("expired");
    expect(listerInv!.qty).toBe(2);
    expect(escrowInv[0]?.qty ?? 0).toBe(0);
    expect(events.length).toBe(0); // nothing sold
    expect(ledgerRows.map((r) => r.reason)).toEqual(["auction_expired"]);
  });

  it("idempotent: a re-fired close is a no-op (no double-delivery)", async () => {
    await seedAuction(h.sql, { id: "auc_i", lister: "lister", item: "gem", qty: 1, price: 300, winner: "winner" });

    const first = await settleAuction(h.sql, { offerId: "auc_i", eventId: "evt_auc_i1" });
    const second = await settleAuction(h.sql, { offerId: "auc_i", eventId: "evt_auc_i2" });

    expect(first.ok && first.outcome).toBe("won");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_settled");

    const [winnerInv] = await h.sql`SELECT qty FROM inventories WHERE owner_kind='player' AND owner_id='winner' AND item_id='gem'`;
    const [listerBal] = await h.sql`SELECT amount FROM balances WHERE owner_kind='player' AND owner_id='lister'`;
    const ledgerRows = await h.sql`SELECT * FROM ledger`;
    expect(winnerInv!.qty).toBe(1); // delivered exactly once
    expect(listerBal!.amount).toBe(300); // paid exactly once
    expect(ledgerRows.length).toBe(2); // no extra rows on re-fire
  });

  it("price=0 trade is a pure item move (listing-escrow assumption)", async () => {
    await h.sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty) VALUES ('player', 'lister', 'axe', 3)`;
    // executeTrade debits the buyer balance even at price=0 (WHERE amount >= 0),
    // so the auction Party needs a (zero) balance row — seeded at listing time.
    await h.sql`INSERT INTO balances (owner_kind, owner_id, currency, amount) VALUES ('auction', 'auc_x', 'gold', 0)`;

    const res = await executeTrade(h.sql, {
      eventId: "evt_escrow",
      buyer: { kind: "auction", id: "auc_x" },
      seller: { kind: "player", id: "lister" },
      itemId: "axe",
      qty: 2,
      price: 0,
      reason: "auction_escrow",
    });
    expect(res.ok).toBe(true);

    const [listerInv] = await h.sql`SELECT qty FROM inventories WHERE owner_kind='player' AND owner_id='lister' AND item_id='axe'`;
    const [escrowInv] = await h.sql`SELECT qty FROM inventories WHERE owner_kind='auction' AND owner_id='auc_x' AND item_id='axe'`;
    const ledgerRows = await h.sql`SELECT * FROM ledger`;
    expect(listerInv!.qty).toBe(1);
    expect(escrowInv!.qty).toBe(2);
    expect(ledgerRows.length).toBe(1); // still ledgered
  });
});

/** Create only the tables this suite exercises, if migrations haven't run. */
async function ensureSchema(handle: DbHandle) {
  const { sql } = handle;
  await sql`CREATE TABLE IF NOT EXISTS events (
    id bigserial PRIMARY KEY, event_id text NOT NULL, type text NOT NULL,
    ts timestamptz NOT NULL DEFAULT now(), guild_id text,
    actor_kind text, actor_id text, subject_kind text, subject_id text,
    payload jsonb NOT NULL DEFAULT '{}', correlation_id text
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS events_event_id_uq ON events(event_id)`;
  await sql`CREATE TABLE IF NOT EXISTS ledger (
    id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
    actor_kind text NOT NULL, actor_id text NOT NULL,
    counterparty_kind text NOT NULL, counterparty_id text NOT NULL,
    currency text NOT NULL DEFAULT 'gold', currency_delta bigint NOT NULL,
    item_deltas jsonb NOT NULL DEFAULT '{}', reason text NOT NULL, cause_event_id bigint
  )`;
  await sql`CREATE TABLE IF NOT EXISTS balances (
    owner_kind text NOT NULL, owner_id text NOT NULL,
    currency text NOT NULL DEFAULT 'gold', amount bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_kind, owner_id, currency)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS inventories (
    owner_kind text NOT NULL, owner_id text NOT NULL, item_id text NOT NULL,
    qty bigint NOT NULL DEFAULT 0, PRIMARY KEY (owner_kind, owner_id, item_id)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS offers (
    id text PRIMARY KEY, kind text NOT NULL, maker_kind text NOT NULL, maker_id text NOT NULL,
    item_id text NOT NULL, qty integer NOT NULL, price bigint NOT NULL,
    side text NOT NULL DEFAULT 'sell', status text NOT NULL DEFAULT 'open',
    expires_at timestamptz, taker_id text, guild_id text
  )`;
  await sql`CREATE TABLE IF NOT EXISTS bids (
    id text PRIMARY KEY, offer_id text NOT NULL, bidder_id text NOT NULL,
    amount bigint NOT NULL, status text NOT NULL DEFAULT 'held',
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
}
