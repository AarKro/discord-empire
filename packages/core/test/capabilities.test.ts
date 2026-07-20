/**
 * Runtime wiring tests for the §10 Merchant path: stall.entered → dialogue
 * session → option choice → trade.request → trade capability (hidden floor →
 * ledger). Discord/Postgres are faked; the pure engines underneath are the
 * real ones.
 */
import { describe, it, expect } from "vitest";
import { Dialogue, Shop, parseContent } from "@empire/content-schemas";
import { tradeCapability, effectiveFloor } from "../src/capabilities/trade.js";
import { dialogueThreadCapability, DIALOGUE_OPTION_PREFIX } from "../src/capabilities/dialogue-thread.js";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";

const shop = parseContent(
  Shop,
  `
id: aldric_wares
currency: gold
items:
  - { item_id: bread, name: Bread, base_price: 5, stock: 100 }
  - item_id: blueprint_arcane_forge
    name: "Blueprint: Arcane Forge"
    base_price: 120
    stock: 1
    floor_price: 90
    reputation_discount: 0.15
`,
  "shop.yaml",
);

const tree = parseContent(
  Dialogue,
  `
id: aldric_haggle
start: greet
nodes:
  - id: greet
    text: "Care to trade?"
    options:
      - { id: browse, label: "Show me", goto: offer }
  - id: offer
    text: "120 gold."
    options:
      - id: buy
        label: "Buy (120g)"
        guard: { expr: "player.gold >= 120" }
        goto: sold
        emit:
          - { type: trade.request, payload: { item: blueprint_arcane_forge, qty: 1, price: 120 } }
      - { id: walk, label: "Too steep", goto: farewell }
  - { id: sold, text: "A pleasure.", final: true }
  - { id: farewell, text: "Safe travels.", final: true }
`,
  "tree.yaml",
);

interface FakeWorld {
  gold: number;
  repScore: number;
  published: { type: string; payload?: Record<string, unknown> }[];
  componentHandlers: ((i: {
    customId: string;
    values: string[];
    userId: string;
    guildId: string | null;
    channelId: string | null;
  }) => Promise<void> | void)[];
  ledgerCalls: number;
}

/** A CapabilityContext whose sql/bus/gateway are in-memory fakes. */
function makeFakeCtx(world: FakeWorld): CapabilityContext {
  const sql = (strings: TemplateStringsArray, ..._vals: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM balances")) return Promise.resolve([{ amount: world.gold }]);
    if (q.includes("FROM reputation") && q.includes("npc_id, score"))
      return Promise.resolve([{ npc_id: "merchant", score: world.repScore }]);
    if (q.includes("FROM reputation")) return Promise.resolve([{ score: world.repScore }]);
    if (q.includes("FROM players"))
      return Promise.resolve([{ flags: {}, position_district_id: "bazaar" }]);
    return Promise.resolve([]);
  };
  // executeTrade returns whatever sql.begin resolves to; the real transaction
  // is covered by the ledger integration suite.
  (sql as unknown as { begin: unknown }).begin = async (): Promise<unknown> => {
    world.ledgerCalls += 1;
    return { ok: true, ledgerId: "1", eventDbId: "1", eventId: "evt_1" };
  };

  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log };
  return {
    bot: "merchant",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string; payload?: Record<string, unknown> }) => {
        world.published.push(input);
        return input as never;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: {
      onComponent: (h: FakeWorld["componentHandlers"][number]) => world.componentHandlers.push(h),
    } as unknown as CapabilityContext["gateway"],
    personas: {
      guildIds: ["g1"],
      homeGuild: (g?: string | null) => g ?? "g1",
    } as unknown as CapabilityContext["personas"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  };
}

function newWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return { gold: 500, repScore: 0, published: [], componentHandlers: [], ledgerCalls: 0, ...overrides };
}

function busEvent(partial: Partial<BusEvent> & { type: string }): BusEvent {
  return {
    dbId: "1",
    eventId: "evt_test",
    ts: new Date().toISOString(),
    guildId: "g1",
    actor: null,
    subject: null,
    payload: {},
    correlationId: null,
    ...partial,
  };
}

describe("effectiveFloor (§5.4 hidden reputation-adjusted floor)", () => {
  const forge = shop.items[1]!;
  it("is the base price for firm-priced items", () => {
    expect(effectiveFloor(shop.items[0]!, 10)).toBe(5);
  });
  it("charges strangers full price and converges to floor_price with reputation", () => {
    expect(effectiveFloor(forge, 0)).toBe(120); // no rep, no discount
    expect(effectiveFloor(forge, 1)).toBe(102); // 120 * 0.85
    expect(effectiveFloor(forge, 3)).toBe(90); // capped at floor_price
    expect(effectiveFloor(forge, 50)).toBe(90); // never below the floor
  });
});

describe("trade capability consumes trade.request", () => {
  it("rejects offers under the hidden floor with an in-fiction trade.failed", async () => {
    const world = newWorld({ repScore: 0 });
    const cap = tradeCapability(shop);
    await cap.handle!(
      busEvent({
        type: "trade.request",
        actor: { kind: "player", id: "p1" },
        subject: { kind: "npc", id: "merchant" },
        payload: { item: "blueprint_arcane_forge", qty: 1, price: 90 },
      }),
      makeFakeCtx(world),
    );
    expect(world.ledgerCalls).toBe(0);
    const failed = world.published.find((e) => e.type === "trade.failed");
    expect(failed?.payload?.reason).toBe("lowball");
  });

  it("accepts the same offer from a regular (rep 3) and reaches the ledger", async () => {
    const world = newWorld({ repScore: 3 });
    const cap = tradeCapability(shop);
    await cap.handle!(
      busEvent({
        type: "trade.request",
        actor: { kind: "player", id: "p1" },
        subject: { kind: "npc", id: "merchant" },
        payload: { item: "blueprint_arcane_forge", qty: 1, price: 90 },
      }),
      makeFakeCtx(world),
    );
    expect(world.ledgerCalls).toBe(1);
    expect(world.published.find((e) => e.type === "trade.failed")).toBeUndefined();
  });
});

describe("dialogue.thread drives the tree end-to-end", () => {
  it("opens on stall.entered, advances on choices, and emits trade.request", async () => {
    const world = newWorld({ gold: 500 });
    const cap = dialogueThreadCapability(tree);
    const ctx = makeFakeCtx(world);
    cap.init!(ctx); // registers the dlg: component bridge

    // Enter the stall → session opens at the greet node.
    await cap.handle!(
      busEvent({ type: "stall.entered", actor: { kind: "player", id: "p1" } }),
      ctx,
    );
    const opened = world.published.find((e) => e.type === "dialogue.opened");
    expect(opened?.payload?.node).toBe("greet");

    // A button click routes through the gateway bridge as dialogue.choose.
    await world.componentHandlers[0]!({
      customId: `${DIALOGUE_OPTION_PREFIX}browse`,
      values: [],
      userId: "p1",
      guildId: "g1",
      channelId: "c1",
    });
    const choose = world.published.find((e) => e.type === "dialogue.choose");
    expect(choose?.payload?.option).toBe("browse");

    // Feed the bus event back to the capability (as the bot's subscribe loop does).
    await cap.handle!(
      busEvent({
        type: "dialogue.choose",
        actor: { kind: "player", id: "p1" },
        subject: { kind: "npc", id: "merchant" },
        payload: { option: "browse" },
      }),
      ctx,
    );
    const nodeEvt = world.published.find((e) => e.type === "dialogue.node");
    expect(nodeEvt?.payload?.node).toBe("offer");
    // The rich player sees the buy option (guard-filtered, prefixed custom id).
    const options = nodeEvt?.payload?.options as { id: string }[];
    expect(options.map((o) => o.id)).toContain("dlg:buy");

    // Buy → the option's emit lands on the bus as trade.request + tree closes.
    await cap.handle!(
      busEvent({
        type: "dialogue.choose",
        actor: { kind: "player", id: "p1" },
        subject: { kind: "npc", id: "merchant" },
        payload: { option: "buy" },
      }),
      ctx,
    );
    const req = world.published.find((e) => e.type === "trade.request");
    expect(req?.payload).toMatchObject({ item: "blueprint_arcane_forge", qty: 1, price: 120 });
    expect(world.published.find((e) => e.type === "dialogue.closed")?.payload?.node).toBe("sold");
  });

  it("ignores guarded options the player does not qualify for", async () => {
    const world = newWorld({ gold: 10 });
    const cap = dialogueThreadCapability(tree);
    const ctx = makeFakeCtx(world);
    await cap.handle!(busEvent({ type: "stall.entered", actor: { kind: "player", id: "p2" } }), ctx);
    await cap.handle!(
      busEvent({ type: "dialogue.choose", actor: { kind: "player", id: "p2" }, payload: { option: "browse" } }),
      ctx,
    );
    // Poor player clicks buy anyway (stale UI): no trade.request, no advance.
    await cap.handle!(
      busEvent({ type: "dialogue.choose", actor: { kind: "player", id: "p2" }, payload: { option: "buy" } }),
      ctx,
    );
    expect(world.published.find((e) => e.type === "trade.request")).toBeUndefined();
    expect(world.published.find((e) => e.type === "dialogue.closed")).toBeUndefined();
  });
});
