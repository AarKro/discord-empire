/**
 * Unit tests for the market capability (§5.11 direct offers): a direct offer is
 * contact-gated and posted (with Accept/Decline) to the recipient's land channel;
 * decline / wrong-recipient / expiry are handled before any trade. The accept →
 * executeTrade → real ledger move is proven in market.integration. Postgres and
 * the gateway are faked.
 */
import { describe, it, expect } from "vitest";
import { marketCapability } from "../src/capabilities/market.js";
import type { BusEvent } from "../src/bus.js";
import type { ComponentInteraction } from "../src/gateway.js";
import type { CapabilityContext } from "../src/capability.js";

interface OfferRow {
  id: string; kind: string; maker_id: string; taker_id: string | null;
  item_id: string; qty: number; price: number; side: string; status: string;
  guild_id: string | null; expires_at: string | null;
}

interface World {
  contacts: boolean;
  offer: OfferRow | null;
  land: Record<string, string | null>;
  marketChannel: string | null;
  posts: { channelId: string; content: string }[];
  replies: string[];
  iReplies: string[];
  iUpdates: string[];
}

function withCount(rows: unknown[], count: number): unknown[] {
  return Object.assign(rows, { count });
}

function makeCtx(world: World): { ctx: CapabilityContext; onComponent: () => (i: ComponentInteraction) => Promise<void> } {
  let handler: (i: ComponentInteraction) => Promise<void> = async () => {};
  const fn = (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM contacts")) return Promise.resolve(world.contacts ? [{ "?column?": 1 }] : []);
    if (q.includes("INSERT INTO offers")) return Promise.resolve([]);
    if (q.includes("SELECT * FROM offers")) return Promise.resolve(world.offer ? [world.offer] : []);
    if (q.includes("UPDATE offers SET status")) {
      const target = /SET status = '(\w+)'/.exec(q)?.[1];
      if (world.offer && target) world.offer.status = target;
      return Promise.resolve(withCount([], 1));
    }
    if (q.includes("FROM land_plots")) return Promise.resolve([{ text_channel_id: world.land[String(vals[0])] ?? null }]);
    if (q.includes("FROM locations")) return Promise.resolve(world.marketChannel ? [{ channel_id: world.marketChannel }] : []);
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
      sendToChannel: async (channelId: string, content: { content?: string }) => { world.posts.push({ channelId, content: content.content ?? "" }); return "m"; },
      onComponent: (h: (i: ComponentInteraction) => Promise<void>) => { handler = h; },
    } as unknown as CapabilityContext["gateway"],
    personas: {} as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
  return { ctx, onComponent: () => handler };
}

const tradeReq = (payload: Record<string, unknown>): BusEvent => ({
  dbId: "0", eventId: "e", type: "offer.direct.requested", ts: "", guildId: "g1",
  actor: { kind: "player", id: "p1" }, subject: { kind: "npc", id: "exchange" }, payload, correlationId: "cmd_1",
});

function click(customId: string, userId: string, world: World): ComponentInteraction {
  return {
    customId, values: [], userId, guildId: "g1", channelId: "c",
    reply: async (c: string) => { world.iReplies.push(c); },
    update: async (c: { content?: string }) => { world.iUpdates.push(c.content ?? ""); },
  };
}

function freshWorld(over: Partial<World> = {}): World {
  return { contacts: true, offer: null, land: {}, marketChannel: null, posts: [], replies: [], iReplies: [], iUpdates: [], ...over };
}

describe("market — direct offers (§5.11)", () => {
  it("posts a contact-gated offer to the recipient's land channel", async () => {
    const world = freshWorld({ land: { p2: "land_p2" } });
    await marketCapability().handle!(tradeReq({ player: "p2", side: "sell", item: "iron", qty: "3", price: "40" }), makeCtx(world).ctx);
    expect(world.posts).toHaveLength(1);
    expect(world.posts[0]!.channelId).toBe("land_p2");
    expect(world.posts[0]!.content).toContain("iron");
    expect(world.replies.some((r) => r.includes("Offer sent"))).toBe(true);
  });

  it("refuses an offer to a stranger (no contact)", async () => {
    const world = freshWorld({ contacts: false, land: { p2: "land_p2" } });
    await marketCapability().handle!(tradeReq({ player: "p2", side: "sell", item: "iron", qty: "3", price: "40" }), makeCtx(world).ctx);
    expect(world.posts).toHaveLength(0);
    expect(world.replies[0]).toContain("don't know them");
  });

  it("falls back to the Marketplace channel when the recipient has no land", async () => {
    const world = freshWorld({ land: {}, marketChannel: "market_g1" });
    await marketCapability().handle!(tradeReq({ player: "p2", side: "sell", item: "iron", qty: "3", price: "40" }), makeCtx(world).ctx);
    expect(world.posts[0]!.channelId).toBe("market_g1");
  });

  const openOffer = (): OfferRow => ({ id: "off1", kind: "direct", maker_id: "p1", taker_id: "p2", item_id: "iron", qty: 3, price: 40, side: "sell", status: "open", guild_id: "g1", expires_at: new Date(Date.now() + 60_000).toISOString() });

  it("decline cancels the offer and edits the message", async () => {
    const world = freshWorld({ offer: openOffer() });
    const { ctx, onComponent } = makeCtx(world);
    marketCapability().init!(ctx);
    await onComponent()(click("mkt:decline:off1", "p2", world));
    expect(world.offer!.status).toBe("cancelled");
    expect(world.iUpdates[0]).toContain("declined");
  });

  it("refuses a click from someone who isn't the recipient", async () => {
    const world = freshWorld({ offer: openOffer() });
    const { ctx, onComponent } = makeCtx(world);
    marketCapability().init!(ctx);
    await onComponent()(click("mkt:accept:off1", "intruder", world));
    expect(world.offer!.status).toBe("open"); // untouched
    expect(world.iReplies[0]).toContain("isn't addressed to you");
  });

  it("refuses an expired offer on accept", async () => {
    const expired = { ...openOffer(), expires_at: new Date(Date.now() - 1000).toISOString() };
    const world = freshWorld({ offer: expired });
    const { ctx, onComponent } = makeCtx(world);
    marketCapability().init!(ctx);
    await onComponent()(click("mkt:accept:off1", "p2", world));
    expect(world.offer!.status).toBe("expired");
    expect(world.iUpdates[0]).toContain("expired");
  });
});
