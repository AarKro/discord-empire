/**
 * Integration suite for the auction capability (§5.11) against a REAL Postgres.
 * Drives the whole money path through the actual capability + executeTrade +
 * settleAuction: listing escrows the item, a bid holds the bidder's gold, an
 * outbid refunds the prior high, and the close settles item→winner + gold→lister
 * (or returns the item unsold). Opt-in on TEST_DATABASE_URL (mirrors ledger).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle, assertMigrated } from "@empire/db";
import { auctionCapability } from "../src/capabilities/auction.js";
import type { BusEvent } from "../src/events/bus.js";
import type { ModalSubmitInteraction } from "../src/gateway/index.js";
import type { CapabilityContext } from "../src/runtime/capability.js";
import { rootLogger } from "../src/logger.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

/** Build the auction cap, capture its modal-submit handler, real sql + noop gateway. */
function setup(): { cap: ReturnType<typeof auctionCapability>; ctx: CapabilityContext; bid: (offerId: string, amount: number, userId: string) => Promise<void>; published: { type: string; payload?: Record<string, unknown> }[] } {
  let submitHandler: (i: ModalSubmitInteraction) => Promise<void> = async () => {};
  const published: { type: string; payload?: Record<string, unknown> }[] = [];
  const ctx = {
    bot: "exchange", sql: h.sql,
    bus: { publish: async (input: { type: string; payload?: Record<string, unknown> }) => { published.push(input); return undefined; } } as unknown as CapabilityContext["bus"],
    gateway: {
      sendToChannel: async () => "m",
      upsertPinnedMessage: async () => null,
      onModalRequest: () => {},
      onModalSubmit: (fn: (i: ModalSubmitInteraction) => Promise<void>) => { submitHandler = fn; },
    } as unknown as CapabilityContext["gateway"],
    personas: {} as unknown as CapabilityContext["personas"],
    logger: rootLogger, config: {},
  } as CapabilityContext;
  const cap = auctionCapability();
  cap.init!(ctx);
  const bid = (offerId: string, amount: number, userId: string) =>
    submitHandler({ customId: `auc:bid:${offerId}`, fields: { amount: String(amount) }, userId, guildId: "g1", channelId: "c", reply: async () => {} });
  return { cap, ctx, bid, published };
}

const listEvt = (lister: string, payload: Record<string, unknown>): BusEvent => ({
  dbId: "0", eventId: "e", type: "auction.list.requested", ts: "", guildId: "g1",
  actor: { kind: "player", id: lister }, subject: { kind: "npc", id: "exchange" }, payload, correlationId: "cmd_1",
});
const closeEvt = (offerId: string): BusEvent => ({
  dbId: "0", eventId: "e", type: "auction.closed", ts: "", guildId: null, payload: { offer_id: offerId }, correlationId: null,
});

const gold = (owner: string, kind = "player") => h.sql<{ amount: number }[]>`SELECT amount FROM balances WHERE owner_kind=${kind} AND owner_id=${owner} AND currency='gold'`;
const itemQty = (owner: string, item: string, kind = "player") => h.sql<{ qty: number }[]>`SELECT qty FROM inventories WHERE owner_kind=${kind} AND owner_id=${owner} AND item_id=${item}`;
const auctionId = () => h.sql<{ id: string }[]>`SELECT id FROM offers WHERE kind='auction' ORDER BY id DESC LIMIT 1`.then((r) => r[0]!.id);

async function seedPlayer(id: string, opts: { gold?: number; items?: [string, number][] } = {}) {
  if (opts.gold != null) await h.sql`INSERT INTO balances (owner_kind, owner_id, currency, amount) VALUES ('player', ${id}, 'gold', ${opts.gold})`;
  for (const [item, qty] of opts.items ?? []) await h.sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty) VALUES ('player', ${id}, ${item}, ${qty})`;
}

suite("auction — full lifecycle against Postgres (§5.11)", () => {
  beforeAll(async () => { h = openDb(url!, { max: 4 }); await assertMigrated(h.sql); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => { await h.sql`TRUNCATE offers, bids, inventories, balances, ledger, events, land_plots, npcs, locations, players RESTART IDENTITY CASCADE`; });

  it("list escrows the item; a bid holds gold; an outbid refunds; close settles", async () => {
    await seedPlayer("lister", { gold: 0, items: [["sword", 1]] });
    await seedPlayer("bidder1", { gold: 500 });
    await seedPlayer("bidder2", { gold: 500 });
    const { cap, ctx, bid } = setup();

    // LIST — item leaves the lister into escrow.
    await cap.handle!(listEvt("lister", { item: "sword", qty: "1", starting_price: "100", duration: "30" }), ctx);
    const id = await auctionId();
    expect((await itemQty("lister", "sword"))[0]?.qty ?? 0).toBe(0);
    expect((await itemQty(id, "sword", "auction"))[0]!.qty).toBe(1);

    // BID 1 (150) — gold held in escrow; becomes the high bid.
    await bid(id, 150, "bidder1");
    expect((await gold("bidder1"))[0]!.amount).toBe(350);
    expect((await gold(id, "auction"))[0]!.amount).toBe(150);
    let [offer] = await h.sql<{ price: number; taker_id: string }[]>`SELECT price, taker_id FROM offers WHERE id=${id}`;
    expect(offer!.price).toBe(150);
    expect(offer!.taker_id).toBe("bidder1");

    // BID 2 (200) — outbids; bidder1 refunded, escrow now holds only bidder2's gold.
    await bid(id, 200, "bidder2");
    expect((await gold("bidder1"))[0]!.amount).toBe(500); // fully refunded
    expect((await gold("bidder2"))[0]!.amount).toBe(300);
    expect((await gold(id, "auction"))[0]!.amount).toBe(200);
    [offer] = await h.sql<{ price: number; taker_id: string }[]>`SELECT price, taker_id FROM offers WHERE id=${id}`;
    expect(offer!.price).toBe(200);
    expect(offer!.taker_id).toBe("bidder2");
    const refunded = await h.sql`SELECT status FROM bids WHERE offer_id=${id} AND bidder_id='bidder1'`;
    expect(refunded[0]!.status).toBe("refunded");

    // CLOSE — winner gets the sword, lister gets the gold, escrow drains.
    await cap.handle!(closeEvt(id), ctx);
    const [closed] = await h.sql<{ status: string }[]>`SELECT status FROM offers WHERE id=${id}`;
    expect(closed!.status).toBe("filled");
    expect((await itemQty("bidder2", "sword"))[0]!.qty).toBe(1);
    expect((await gold("lister"))[0]!.amount).toBe(200);
    expect((await itemQty(id, "sword", "auction"))[0]?.qty ?? 0).toBe(0);
    // The hub is per-auction scaffolding: its rows are retired at the close, and
    // so is the winner's hold token (escrow plumbing, never a real possession).
    expect(await gold(id, "auction")).toEqual([]);
    expect(await itemQty(id, "auction_bid", "auction")).toEqual([]);
    expect((await itemQty("bidder2", "auction_bid"))[0]?.qty ?? 0).toBe(0);
  });

  it("no bids: the close returns the item to the lister (unsold)", async () => {
    await seedPlayer("lister", { gold: 0, items: [["shield", 2]] });
    const { cap, ctx, published } = setup();
    await cap.handle!(listEvt("lister", { item: "shield", qty: "2", starting_price: "500", duration: "30" }), ctx);
    const id = await auctionId();
    expect((await itemQty("lister", "shield"))[0]?.qty ?? 0).toBe(0); // escrowed

    await cap.handle!(closeEvt(id), ctx);
    const [closed] = await h.sql<{ status: string }[]>`SELECT status FROM offers WHERE id=${id}`;
    expect(closed!.status).toBe("expired");
    expect((await itemQty("lister", "shield"))[0]!.qty).toBe(2); // returned
    // An unsold auction is not worth a realm announcement (§9).
    expect(published.some((e) => e.type === "world.announce")).toBe(false);
  });

  it("a sold close announces the result to the realm (§9)", async () => {
    await seedPlayer("lister", { gold: 0, items: [["crown", 1]] });
    await seedPlayer("bidder1", { gold: 500 });
    const { cap, ctx, bid, published } = setup();
    await cap.handle!(listEvt("lister", { item: "crown", qty: "1", starting_price: "100", duration: "30" }), ctx);
    const id = await auctionId();
    await bid(id, 250, "bidder1");

    await cap.handle!(closeEvt(id), ctx);
    const announce = published.find((e) => e.type === "world.announce");
    expect(announce).toBeDefined();
    expect(String(announce!.payload!.message)).toContain("crown");
    expect(String(announce!.payload!.message)).toContain("250 gold");
  });

  it("a re-fired close is idempotent (no double-delivery)", async () => {
    await seedPlayer("lister", { gold: 0, items: [["gem", 1]] });
    await seedPlayer("bidder1", { gold: 500 });
    const { cap, ctx, bid } = setup();
    await cap.handle!(listEvt("lister", { item: "gem", qty: "1", starting_price: "100", duration: "30" }), ctx);
    const id = await auctionId();
    await bid(id, 300, "bidder1");

    await cap.handle!(closeEvt(id), ctx); // first close
    await cap.handle!(closeEvt(id), ctx); // tick re-fire

    expect((await itemQty("bidder1", "gem"))[0]!.qty).toBe(1); // delivered once
    expect((await gold("lister"))[0]!.amount).toBe(300); // paid once
  });

  it("a bid below the reserve moves no gold", async () => {
    await seedPlayer("lister", { gold: 0, items: [["ring", 1]] });
    await seedPlayer("bidder1", { gold: 500 });
    const { cap, ctx, bid } = setup();
    await cap.handle!(listEvt("lister", { item: "ring", qty: "1", starting_price: "100", duration: "30" }), ctx);
    const id = await auctionId();

    await bid(id, 50, "bidder1"); // under reserve
    expect((await gold("bidder1"))[0]!.amount).toBe(500); // untouched
    const [offer] = await h.sql<{ taker_id: string | null }[]>`SELECT taker_id FROM offers WHERE id=${id}`;
    expect(offer!.taker_id).toBeNull();
  });
});
