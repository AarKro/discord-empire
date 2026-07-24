/**
 * Unit tests for the stall's re-render addressing (§3). The bus is a BROADCAST
 * log: every bot sees every `trade.completed`, but only this NPC's own sales
 * change its stock. Without the addressing guard the pinned embed was re-drawn
 * — a Discord edit plus a `stall.rendered` event — for every trade in the realm
 * (auction escrows, player-to-player stall buys, the Builder's permit charge).
 */
import { describe, it, expect } from "vitest";
import { stallCapability } from "../src/capabilities/stall.js";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";

const SHOP = { id: "aldric", currency: "gold", items: [{ item_id: "x", name: "Trinket", base_price: 5, stock: 3 }] };

function makeCtx(): { ctx: CapabilityContext; rendered: string[] } {
  const rendered: string[] = [];
  const fn = (): Promise<unknown[]> => Promise.resolve([]);
  const sql = Object.assign(fn, { begin: async (cb: (tx: unknown) => unknown) => cb(sql) });
  const ctx = {
    bot: "merchant",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string }) => {
        rendered.push(input.type);
        return undefined;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: { onComponent: () => {} } as unknown as CapabilityContext["gateway"],
    personas: {
      homeGuild: (g?: string | null) => g ?? "g1",
      has: () => true,
      resolve: () => ({ nickname: "Aldric" }),
    } as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
  return { ctx, rendered };
}

function tradeEvt(sellerId: string | null): BusEvent {
  return {
    dbId: "1", eventId: "e1", type: "trade.completed", ts: "", guildId: "g1",
    actor: { kind: "player", id: "p1" },
    subject: sellerId ? { kind: "npc", id: sellerId } : null,
    payload: {}, correlationId: null,
  };
}

describe("stall re-render addressing (§3 broadcast bus)", () => {
  it("re-renders when this NPC made the sale", async () => {
    const { ctx, rendered } = makeCtx();
    const cap = stallCapability(SHOP);
    await cap.handle!(tradeEvt("merchant"), ctx);
    expect(rendered).toEqual(["stall.rendered"]);
  });

  it("ignores a trade settled by another NPC", async () => {
    const { ctx, rendered } = makeCtx();
    const cap = stallCapability(SHOP);
    await cap.handle!(tradeEvt("builder"), ctx);
    expect(rendered).toEqual([]);
  });

  it("ignores a player-to-player sale (subject is the selling player)", async () => {
    const { ctx, rendered } = makeCtx();
    const cap = stallCapability(SHOP);
    const evt = { ...tradeEvt(null), subject: { kind: "player", id: "p2" } } as BusEvent;
    await cap.handle!(evt, ctx);
    expect(rendered).toEqual([]);
  });

  it("still renders an unaddressed trade (no subject reaches every bot)", async () => {
    const { ctx, rendered } = makeCtx();
    const cap = stallCapability(SHOP);
    await cap.handle!(tradeEvt(null), ctx);
    expect(rendered).toEqual(["stall.rendered"]);
  });

  it("skips the render on a continent where this NPC has no persona", async () => {
    const { ctx, rendered } = makeCtx();
    (ctx.personas as unknown as { has: () => boolean }).has = () => false;
    const cap = stallCapability(SHOP);
    await cap.handle!(tradeEvt("merchant"), ctx);
    expect(rendered).toEqual([]);
  });
});
