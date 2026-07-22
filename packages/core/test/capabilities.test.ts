/**
 * Trade-capability wiring for the §10 Merchant path: a trade.request is checked
 * against the hidden reputation-adjusted floor before it reaches the ledger.
 * Discord/Postgres are faked; the pure floor math underneath is the real one.
 * (The dialogue path — stall.entered → prompt → option → trade.request — is now a
 * workflow, covered by the workflow engine + runtime suites.)
 */
import { describe, it, expect } from "vitest";
import { Shop, parseContent } from "@empire/content-schemas";
import { tradeCapability, effectiveFloor } from "../src/capabilities/trade.js";
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

interface FakeWorld {
  gold: number;
  repScore: number;
  published: { type: string; payload?: Record<string, unknown> }[];
  ledgerCalls: number;
}

/** A CapabilityContext whose sql/bus/gateway are in-memory fakes. */
function makeFakeCtx(world: FakeWorld): CapabilityContext {
  const sql = (strings: TemplateStringsArray, ..._vals: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM balances")) return Promise.resolve([{ amount: world.gold }]);
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
    gateway: {} as unknown as CapabilityContext["gateway"],
    personas: {
      guildIds: ["g1"],
      homeGuild: (g?: string | null) => g ?? "g1",
    } as unknown as CapabilityContext["personas"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  };
}

function newWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return { gold: 500, repScore: 0, published: [], ledgerCalls: 0, ...overrides };
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
