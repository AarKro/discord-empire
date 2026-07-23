/**
 * Integration suite for the market capability (§5.11): accepting a direct offer
 * settles through the REAL executeTrade against Postgres — item + gold move
 * atomically between the two players, the offer flips to 'filled', and the party
 * DIRECTION follows the offer's side. Opt-in on TEST_DATABASE_URL (mirrors ledger).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "@empire/db";
import { marketCapability, buildMarketOverviewEmbed } from "../src/capabilities/market.js";
import type { Continents } from "@empire/content-schemas";
import type { ComponentInteraction } from "../src/gateway.js";
import type { CapabilityContext } from "../src/capability.js";
import { rootLogger } from "../src/logger.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

/** Build the market cap, capture its onComponent handler, real sql + a noop gateway. */
function setup(): (i: ComponentInteraction) => Promise<void> {
  let handler: (i: ComponentInteraction) => Promise<void> = async () => {};
  const ctx = {
    bot: "exchange", sql: h.sql,
    bus: { publish: async () => undefined } as unknown as CapabilityContext["bus"],
    gateway: { sendToChannel: async () => "m", upsertPinnedMessage: async () => null, onComponent: (fn: (i: ComponentInteraction) => Promise<void>) => { handler = fn; } } as unknown as CapabilityContext["gateway"],
    personas: {} as unknown as CapabilityContext["personas"],
    logger: rootLogger, config: {},
  } as CapabilityContext;
  marketCapability().init!(ctx);
  return handler;
}

function clickBtn(customId: string, userId: string): ComponentInteraction {
  return { customId, values: [], userId, guildId: "g1", channelId: "c", reply: async () => {}, update: async () => {} };
}
const accept = (offerId: string, userId: string) => clickBtn(`mkt:accept:${offerId}`, userId);

const bal = (owner: string) => h.sql<{ amount: number }[]>`SELECT amount FROM balances WHERE owner_kind='player' AND owner_id=${owner} AND currency='gold'`;
const inv = (owner: string) => h.sql<{ qty: number }[]>`SELECT qty FROM inventories WHERE owner_kind='player' AND owner_id=${owner} AND item_id='iron'`;

async function seedOffer(side: "sell" | "buy") {
  // Direct offer p1 → p2. sell: p1 gives iron, p2 pays. buy: p1 pays, p2 gives iron.
  await h.sql`INSERT INTO offers (id, kind, maker_kind, maker_id, taker_id, item_id, qty, price, side, status, guild_id, expires_at)
    VALUES ('off1', 'direct', 'player', 'p1', 'p2', 'iron', 3, 40, ${side}, 'open', 'g1', now() + interval '10 minutes')`;
  const seller = side === "sell" ? "p1" : "p2";
  const buyer = side === "sell" ? "p2" : "p1";
  await h.sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty) VALUES ('player', ${seller}, 'iron', 3)`;
  await h.sql`INSERT INTO balances (owner_kind, owner_id, currency, amount) VALUES ('player', ${buyer}, 'gold', 100)`;
}

suite("market — accepting a direct offer settles atomically (§5.11)", () => {
  beforeAll(async () => { h = openDb(url!, { max: 4 }); await ensureSchema(h); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => { await h.sql`TRUNCATE offers, contacts, inventories, balances, ledger, events, land_plots, npcs, locations RESTART IDENTITY CASCADE`; });

  it("sell offer: the recipient accepts, pays gold, receives the goods", async () => {
    await seedOffer("sell");
    await setup()(accept("off1", "p2")); // p2 is the taker

    const [offer] = await h.sql<{ status: string }[]>`SELECT status FROM offers WHERE id='off1'`;
    expect(offer!.status).toBe("filled");
    expect((await inv("p2"))[0]!.qty).toBe(3); // buyer got the iron
    expect((await inv("p1"))[0]?.qty ?? 0).toBe(0); // seller gave it up
    expect((await bal("p2"))[0]!.amount).toBe(60); // buyer paid 40
    expect((await bal("p1"))[0]!.amount).toBe(40); // seller was paid
    expect((await h.sql`SELECT id FROM ledger WHERE reason='player_trade'`).length).toBe(1);
  });

  it("buy offer: parties are reversed — the maker pays, the recipient supplies", async () => {
    await seedOffer("buy");
    await setup()(accept("off1", "p2")); // p2 (taker) confirms

    const [offer] = await h.sql<{ status: string }[]>`SELECT status FROM offers WHERE id='off1'`;
    expect(offer!.status).toBe("filled");
    expect((await inv("p1"))[0]!.qty).toBe(3); // buyer (maker) received iron
    expect((await bal("p1"))[0]!.amount).toBe(60); // maker paid 40
    expect((await bal("p2"))[0]!.amount).toBe(40); // recipient (seller) was paid
  });

  it("a stale/absent offer is a no-op (no ledger row)", async () => {
    await setup()(accept("nope", "p2"));
    expect((await h.sql`SELECT id FROM ledger`).length).toBe(0);
  });

  it("stall listing: a buyer clicks Buy → atomic swap + offer filled", async () => {
    await h.sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty) VALUES ('player', 'p1', 'iron', 3)`;
    await h.sql`INSERT INTO balances (owner_kind, owner_id, currency, amount) VALUES ('player', 'p2', 'gold', 100)`;
    await h.sql`INSERT INTO offers (id, kind, maker_kind, maker_id, item_id, qty, price, side, status, guild_id)
      VALUES ('ord1', 'order', 'player', 'p1', 'iron', 3, 40, 'sell', 'open', 'g1')`;

    await setup()(clickBtn("mkt:buy:ord1", "p2"));

    const [offer] = await h.sql<{ status: string }[]>`SELECT status FROM offers WHERE id='ord1'`;
    expect(offer!.status).toBe("filled");
    expect((await inv("p2"))[0]!.qty).toBe(3); // buyer got the iron
    expect((await bal("p2"))[0]!.amount).toBe(60); // paid 40
    expect((await bal("p1"))[0]!.amount).toBe(40); // seller was paid
  });

  it("/market overview: own positions + cross-continent browse, own listings excluded from browse", async () => {
    const continents = {
      continents: {
        g1: { name: "Continent One", order: 1, neighbors: ["g2"], resource_bias: "highlands", locale_flavor: "highlands" },
        g2: { name: "Continent Two", order: 2, neighbors: ["g1"], resource_bias: "harbor", locale_flavor: "harbor" },
      },
    } as unknown as Continents;

    // p1's own open positions: a stall + an auction they listed (g1)…
    await h.sql`INSERT INTO offers (id, kind, maker_kind, maker_id, item_id, qty, price, side, status, guild_id)
      VALUES ('s1', 'order', 'player', 'p1', 'iron', 3, 40, 'sell', 'open', 'g1')`;
    await h.sql`INSERT INTO offers (id, kind, maker_kind, maker_id, item_id, qty, price, side, status, guild_id, expires_at)
      VALUES ('a1', 'auction', 'player', 'p1', 'ruby', 1, 50, 'sell', 'open', 'g1', now() + interval '20 minutes')`;
    // …and an auction in g2 where p1 is the current high bidder (someone else's lot).
    await h.sql`INSERT INTO offers (id, kind, maker_kind, maker_id, taker_id, item_id, qty, price, side, status, guild_id, expires_at)
      VALUES ('a2', 'auction', 'player', 'p2', 'p1', 'silk', 2, 40, 'sell', 'open', 'g2', now() + interval '5 minutes')`;
    // Others' listings across both continents.
    await h.sql`INSERT INTO offers (id, kind, maker_kind, maker_id, item_id, qty, price, side, status, guild_id)
      VALUES ('s2', 'order', 'player', 'p2', 'wheat', 20, 3, 'sell', 'open', 'g1')`;
    await h.sql`INSERT INTO offers (id, kind, maker_kind, maker_id, item_id, qty, price, side, status, guild_id, expires_at)
      VALUES ('a3', 'auction', 'player', 'p3', 'map', 1, 15, 'sell', 'open', 'g2', now() + interval '22 minutes')`;

    const json = (await buildMarketOverviewEmbed(h.sql, continents, "p1")).toJSON();
    const fields = json.fields ?? [];
    const value = (name: string) => fields.find((f) => f.name === name)?.value ?? "";

    const positions = value("Your positions");
    expect(positions).toContain("iron"); // own stall
    expect(positions).toContain("ruby"); // own auction
    expect(positions).toContain("silk"); // the escrowed high bid
    expect(positions).toContain("escrowed");

    const one = value("Browse · Continent One");
    expect(one).toContain("wheat"); // another player's stall
    expect(one).not.toContain("iron"); // own stall excluded from browse
    expect(one).not.toContain("ruby"); // own auction excluded from browse

    expect(value("Browse · Continent Two")).toContain("map"); // p3's auction
  });
});

async function ensureSchema(handle: DbHandle) {
  const { sql } = handle;
  await sql`CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, event_id text NOT NULL, type text NOT NULL, ts timestamptz NOT NULL DEFAULT now(), guild_id text, actor_kind text, actor_id text, subject_kind text, subject_id text, payload jsonb NOT NULL DEFAULT '{}', correlation_id text)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS events_event_id_uq ON events(event_id)`;
  await sql`CREATE TABLE IF NOT EXISTS ledger (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), actor_kind text NOT NULL, actor_id text NOT NULL, counterparty_kind text NOT NULL, counterparty_id text NOT NULL, currency text NOT NULL DEFAULT 'gold', currency_delta bigint NOT NULL, item_deltas jsonb NOT NULL DEFAULT '{}', reason text NOT NULL, cause_event_id bigint)`;
  await sql`CREATE TABLE IF NOT EXISTS balances (owner_kind text NOT NULL, owner_id text NOT NULL, currency text NOT NULL DEFAULT 'gold', amount bigint NOT NULL DEFAULT 0, PRIMARY KEY (owner_kind, owner_id, currency))`;
  await sql`CREATE TABLE IF NOT EXISTS inventories (owner_kind text NOT NULL, owner_id text NOT NULL, item_id text NOT NULL, qty bigint NOT NULL DEFAULT 0, PRIMARY KEY (owner_kind, owner_id, item_id))`;
  await sql`CREATE TABLE IF NOT EXISTS offers (id text PRIMARY KEY, kind text NOT NULL, maker_kind text NOT NULL, maker_id text NOT NULL, taker_id text, item_id text NOT NULL, qty integer NOT NULL, price bigint NOT NULL, side text NOT NULL DEFAULT 'sell', status text NOT NULL DEFAULT 'open', guild_id text, expires_at timestamptz)`;
  await sql`CREATE TABLE IF NOT EXISTS contacts (player_a text NOT NULL, player_b text NOT NULL, met_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (player_a, player_b))`;
  await sql`CREATE TABLE IF NOT EXISTS land_plots (id text PRIMARY KEY, owner_id text NOT NULL, guild_id text NOT NULL, district_id text, voice_channel_id text, text_channel_id text, pruned boolean NOT NULL DEFAULT false)`;
  await sql`CREATE TABLE IF NOT EXISTS npcs (id text PRIMARY KEY, kind text NOT NULL, state jsonb NOT NULL DEFAULT '{}')`;
  await sql`CREATE TABLE IF NOT EXISTS locations (id text PRIMARY KEY, guild_id text NOT NULL, channel_id text, district_id text, kind text NOT NULL, requires_presence boolean NOT NULL DEFAULT false)`;
}
