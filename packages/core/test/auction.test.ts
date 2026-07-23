/**
 * Unit tests for the auction capability (§5.11): the pre-escrow validation paths
 * — listing needs stock; a bid is rejected for a closed/expired/own auction, a
 * non-numeric amount, or one under the reserve / current high — all BEFORE any
 * executeTrade. The escrow → refund → settle money moves are proven against a
 * real Postgres in auction.integration. Postgres and the gateway are faked.
 */
import { describe, it, expect } from "vitest";
import { auctionCapability } from "../src/capabilities/auction.js";
import type { BusEvent } from "../src/bus.js";
import type { ModalSubmitInteraction, ModalRequest } from "../src/gateway.js";
import type { CapabilityContext } from "../src/capability.js";

interface OfferRow {
  id: string; kind: string; maker_id: string; taker_id: string | null;
  item_id: string; qty: number; price: number; side: string; status: string;
  guild_id: string | null; expires_at: string | null;
}

interface World {
  offer: OfferRow | null;
  position: string | null;
  inventoryQty: number;
  replies: string[];
  mReplies: string[];
  boardRenders: number;
}

function makeCtx(world: World): {
  ctx: CapabilityContext;
  onModalSubmit: () => (i: ModalSubmitInteraction) => Promise<void>;
  onModalRequest: () => ModalRequest;
} {
  let submitHandler: (i: ModalSubmitInteraction) => Promise<void> = async () => {};
  let request: ModalRequest = { matches: () => false, build: () => ({}) as never };
  const fn = (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    void vals;
    const q = strings.join("?");
    if (q.includes("SELECT * FROM offers")) return Promise.resolve(world.offer ? [world.offer] : []);
    if (q.includes("qty FROM inventories")) return Promise.resolve([{ qty: world.inventoryQty }]);
    if (q.includes("position_guild_id FROM players")) return Promise.resolve([{ position_guild_id: world.position }]);
    return Promise.resolve([]);
  };
  const ctx = {
    bot: "exchange",
    sql: fn as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string; payload?: { message?: string } }) => {
        if (input.type === "command.reply") world.replies.push(input.payload!.message!);
        return undefined;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: {
      sendToChannel: async () => "m",
      upsertPinnedMessage: async () => { world.boardRenders += 1; return "board_msg"; },
      onModalRequest: (r: ModalRequest) => { request = r; },
      onModalSubmit: (h: (i: ModalSubmitInteraction) => Promise<void>) => { submitHandler = h; },
    } as unknown as CapabilityContext["gateway"],
    personas: {} as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
  return { ctx, onModalSubmit: () => submitHandler, onModalRequest: () => request };
}

function freshWorld(over: Partial<World> = {}): World {
  return { offer: null, position: "g1", inventoryQty: 0, replies: [], mReplies: [], boardRenders: 0, ...over };
}

const listEvt = (payload: Record<string, unknown>): BusEvent => ({
  dbId: "0", eventId: "e", type: "auction.list.requested", ts: "", guildId: "g1",
  actor: { kind: "player", id: "p1" }, subject: { kind: "npc", id: "exchange" }, payload, correlationId: "cmd_1",
});

function submit(customId: string, amount: string, userId: string, world: World): ModalSubmitInteraction {
  return {
    customId, fields: { amount }, userId, guildId: "g1", channelId: "c",
    reply: async (c: string) => { world.mReplies.push(c); },
  };
}

const openAuction = (over: Partial<OfferRow> = {}): OfferRow => ({
  id: "off1", kind: "auction", maker_id: "lister", taker_id: null, item_id: "sword", qty: 1,
  price: 100, side: "sell", status: "open", guild_id: "g1", expires_at: new Date(Date.now() + 60_000).toISOString(), ...over,
});

describe("auction — listing (§5.11)", () => {
  it("refuses to auction more than the lister holds (before escrow)", async () => {
    const world = freshWorld({ inventoryQty: 0 });
    await auctionCapability().handle!(listEvt({ item: "sword", qty: "1", starting_price: "100", duration: "30" }), makeCtx(world).ctx);
    expect(world.replies[0]).toContain("don't have");
    expect(world.boardRenders).toBe(0);
  });

  it("refuses a listing with no price or duration", async () => {
    const world = freshWorld({ inventoryQty: 5 });
    await auctionCapability().handle!(listEvt({ item: "sword", qty: "1", starting_price: "0", duration: "30" }), makeCtx(world).ctx);
    expect(world.replies[0]).toContain("starting price");
    expect(world.boardRenders).toBe(0);
  });
});

describe("auction — bidding validation (§5.11)", () => {
  async function bid(world: World, customId: string, amount: string, userId = "bidder"): Promise<void> {
    const { ctx, onModalSubmit } = makeCtx(world);
    await auctionCapability().init!(ctx);
    await onModalSubmit()(submit(customId, amount, userId, world));
  }

  it("rejects a bid on a closed auction", async () => {
    const world = freshWorld({ offer: openAuction({ status: "filled" }) });
    await bid(world, "auc:bid:off1", "150");
    expect(world.mReplies[0]).toContain("closed");
  });

  it("rejects a bid on an expired auction", async () => {
    const world = freshWorld({ offer: openAuction({ expires_at: new Date(Date.now() - 1000).toISOString() }) });
    await bid(world, "auc:bid:off1", "150");
    expect(world.mReplies[0]).toContain("ended");
  });

  it("rejects bidding on your own auction", async () => {
    const world = freshWorld({ offer: openAuction() });
    await bid(world, "auc:bid:off1", "150", "lister");
    expect(world.mReplies[0]).toContain("your own auction");
  });

  it("rejects a non-integer bid amount", async () => {
    const world = freshWorld({ offer: openAuction() });
    await bid(world, "auc:bid:off1", "12.5");
    expect(world.mReplies[0]).toContain("whole number");
  });

  it("rejects a first bid below the reserve (starting price)", async () => {
    const world = freshWorld({ offer: openAuction({ price: 100, taker_id: null }) });
    await bid(world, "auc:bid:off1", "99");
    expect(world.mReplies[0]).toContain("at least 100");
  });

  it("rejects a later bid that doesn't beat the current high", async () => {
    const world = freshWorld({ offer: openAuction({ price: 200, taker_id: "someone" }) });
    await bid(world, "auc:bid:off1", "200"); // must be >= 201
    expect(world.mReplies[0]).toContain("at least 201");
  });

  it("ignores a modal submit whose customId isn't a bid, and matches bid ids", async () => {
    const world = freshWorld({ offer: openAuction() });
    const { ctx, onModalSubmit, onModalRequest } = makeCtx(world);
    await auctionCapability().init!(ctx);
    expect(onModalRequest().matches("auc:bid:off1")).toBe(true);
    expect(onModalRequest().matches("mkt:buy:off1")).toBe(false);
    await onModalSubmit()(submit("other:thing", "150", "bidder", world));
    expect(world.mReplies).toHaveLength(0); // no-op, not a bid
  });
});
