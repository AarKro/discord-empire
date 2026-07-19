/**
 * ensurePlayer contract against real Postgres (same opt-in pattern as the
 * ledger suite): first interaction creates the player exactly once and the
 * starting grant reconciles balance ↔ ledger; every later call is a no-op.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "../src/client.js";
import { ensurePlayer } from "../src/grant.js";

// Never DATABASE_URL: this suite truncates shared tables (see ledger suite).
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

suite("ensurePlayer starting grant", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 10 });
    await ensureSchema(h);
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.sql`TRUNCATE players, balances, ledger RESTART IDENTITY CASCADE`;
  });

  it("creates the player once with a ledger-backed grant", async () => {
    const first = await ensurePlayer(h.sql, "u1", "g1", 150);
    const second = await ensurePlayer(h.sql, "u1", "g1", 150);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const [player] = await h.sql`SELECT home_guild_id FROM players WHERE discord_user_id='u1'`;
    const [bal] = await h.sql`SELECT amount FROM balances WHERE owner_kind='player' AND owner_id='u1'`;
    const grants = await h.sql`SELECT currency_delta FROM ledger WHERE actor_id='u1' AND reason='starting_grant'`;

    expect(player!.home_guild_id).toBe("g1");
    expect(bal!.amount).toBe(150);
    expect(grants.length).toBe(1);
    expect(grants[0]!.currency_delta).toBe(150);
  });

  it("grants exactly once under a concurrent double click", async () => {
    const results = await Promise.all([
      ensurePlayer(h.sql, "u2", "g1", 150),
      ensurePlayer(h.sql, "u2", "g1", 150),
    ]);
    expect(results.filter((r) => r.created).length).toBe(1);

    const [bal] = await h.sql`SELECT amount FROM balances WHERE owner_kind='player' AND owner_id='u2'`;
    const grants = await h.sql`SELECT id FROM ledger WHERE actor_id='u2' AND reason='starting_grant'`;
    expect(bal!.amount).toBe(150);
    expect(grants.length).toBe(1);
  });
});

/** Create only the tables this suite exercises, if migrations haven't run. */
async function ensureSchema(handle: DbHandle) {
  const { sql } = handle;
  await sql`CREATE TABLE IF NOT EXISTS players (
    discord_user_id text PRIMARY KEY,
    home_guild_id text NOT NULL,
    position_guild_id text,
    position_district_id text,
    tier integer NOT NULL DEFAULT 1,
    notification_prefs jsonb NOT NULL DEFAULT '{"target":"land","dm":false}',
    flags jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS balances (
    owner_kind text NOT NULL, owner_id text NOT NULL,
    currency text NOT NULL DEFAULT 'gold',
    amount bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_kind, owner_id, currency)
  )`;
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
}
