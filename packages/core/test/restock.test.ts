/**
 * Unit tests for the restock sweep (§2.5, §3 `stock.restocked`). Postgres is
 * faked; the policy itself is pure and tested in goods.test.ts, so what's pinned
 * here is WHEN the sweep acts and what it writes.
 *
 * Two properties matter most. An idle world must write NOTHING — a sweep that
 * ledgered a no-op every minute would bury the audit trail it exists to keep.
 * And the clock must be elapsed wall-time, not tick counts, or a bot redeployed
 * more often than the interval would restock never.
 */
import { describe, it, expect } from "vitest";
import { restockCapability, RESTOCK_INTERVAL_MS } from "../src/capabilities/restock.js";
import { UNLIMITED_STOCK, UNLIMITED_FLOOR } from "../src/world/goods.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";
import type { Continents, Shop } from "@empire/content-schemas";

const SHOP: Shop = {
  id: "aldric_wares",
  currency: "gold",
  items: [
    { item_id: "bread", name: "Loaf of Bread", base_price: 5, stock: 100, unlimited: true },
    { item_id: "iron_ore", name: "Iron Ore", base_price: 25, stock: 40, origin: "highlands", restock: 10 },
    { item_id: "relic", name: "Relic", base_price: 500, stock: 1 },
  ],
};

const CONTINENTS: Continents = {
  continents: { g1: { name: "Continent One", order: 1, neighbors: [], resource_bias: "highlands" } },
};

interface World {
  /** Live NPC stock, keyed by owner id. */
  stock: Record<string, { item_id: string; qty: number }[]>;
  /** `npcs.state.restocked_at`, as the capability will read it. */
  restockedAt: Record<string, string>;
  queries: string[];
  /** Every restockShop transaction that actually ran, as (owner, item, qty). */
  writes: { owner: string; item: string; qty: number }[];
  published: { type: string; guildId?: string | null }[];
  stateWrites: { key: string; value: string }[];
}

function baseWorld(over: Partial<World> = {}): World {
  return { stock: {}, restockedAt: {}, queries: [], writes: [], published: [], stateWrites: [], ...over };
}

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    world.queries.push(q);
    if (q.includes("SELECT state FROM npcs")) return Promise.resolve([{ state: { restocked_at: world.restockedAt } }]);
    if (q.includes("UPDATE npcs SET state")) {
      // upsertNpcStateEntry binds the map name three times before the key, and
      // passes the value through jsonParam — so pick both out by shape rather
      // than by a positional index that would silently drift.
      const iso = values.map((v) => String(v)).flatMap((v) => /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(v) ?? [])[1] ?? "";
      world.stateWrites.push({ key: String(values[3]), value: iso });
      return Promise.resolve([]);
    }
    if (q.includes("FROM inventories")) return Promise.resolve(world.stock[String(values[0])] ?? []);
    // The restockShop transaction's inventory upsert, captured as the write.
    if (q.includes("INSERT INTO inventories")) {
      world.writes.push({ owner: String(values[0]), item: String(values[1]), qty: Number(values[2]) });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(sql);
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log };
  return {
    bot: "merchant",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string; guildId?: string | null }) => {
        world.published.push(input);
        return undefined as never;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: {} as unknown as CapabilityContext["gateway"],
    personas: { guildIds: ["g1"], homeGuild: (g?: string | null) => g ?? "g1", has: () => true } as unknown as CapabilityContext["personas"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

const tick = () => ({ type: "tick.minute", payload: { minute: 1 } }) as unknown as BusEvent;

/** An ISO timestamp `intervals` restock-intervals in the past. */
const ago = (intervals: number) => new Date(Date.now() - intervals * RESTOCK_INTERVAL_MS - 1000).toISOString();

const cap = restockCapability({}, SHOP, CONTINENTS);

describe("the restock sweep (§3 stock.restocked)", () => {
  it("tops a depleted shelf up to its rate once an interval has passed", async () => {
    const world = baseWorld({
      stock: { "merchant@g1": [{ item_id: "iron_ore", qty: 5 }] },
      restockedAt: { g1: ago(1) },
    });
    await cap.handle!(tick(), makeCtx(world));

    expect(world.writes).toContainEqual({ owner: "merchant@g1", item: "iron_ore", qty: 10 });
    expect(world.published.map((p) => p.type)).toEqual(["shop.restocked"]);
  });

  it("writes NOTHING when every shelf is already full", async () => {
    // An idle world must not ledger a no-op every minute; the audit trail is the
    // point of writing through the ledger at all.
    const world = baseWorld({
      stock: { "merchant@g1": [{ item_id: "iron_ore", qty: 40 }, { item_id: "bread", qty: UNLIMITED_STOCK }] },
      restockedAt: { g1: ago(1) },
    });
    await cap.handle!(tick(), makeCtx(world));

    expect(world.writes).toEqual([]);
    expect(world.published).toEqual([]);
  });

  it("does nothing before an interval has elapsed", async () => {
    const world = baseWorld({
      stock: { "merchant@g1": [{ item_id: "iron_ore", qty: 0 }] },
      restockedAt: { g1: new Date().toISOString() },
    });
    await cap.handle!(tick(), makeCtx(world));

    expect(world.writes).toEqual([]);
  });

  it("stamps a first-seen continent instead of paying out from the epoch", async () => {
    // Without this a fresh world's first tick would compute ~57 years of
    // intervals and fill every shelf instantly.
    const world = baseWorld({ stock: { "merchant@g1": [{ item_id: "iron_ore", qty: 0 }] } });
    await cap.handle!(tick(), makeCtx(world));

    expect(world.writes).toEqual([]);
    expect(world.stateWrites).toHaveLength(1);
    expect(world.stateWrites[0]!.key).toBe("g1");
  });

  it("catches up after downtime but never past the cap", async () => {
    const world = baseWorld({
      stock: { "merchant@g1": [{ item_id: "iron_ore", qty: 0 }] },
      restockedAt: { g1: ago(100) },
    });
    await cap.handle!(tick(), makeCtx(world));

    expect(world.writes).toContainEqual({ owner: "merchant@g1", item: "iron_ore", qty: 40 });
  });

  it("never brings back a rare that carries no rate", async () => {
    const world = baseWorld({
      stock: { "merchant@g1": [{ item_id: "relic", qty: 0 }] },
      restockedAt: { g1: ago(50) },
    });
    await cap.handle!(tick(), makeCtx(world));

    expect(world.writes.some((w) => w.item === "relic")).toBe(false);
  });

  it("refills an unlimited ware only once it dips below the floor", async () => {
    const world = baseWorld({
      stock: { "merchant@g1": [{ item_id: "bread", qty: UNLIMITED_FLOOR - 1 }] },
      restockedAt: { g1: ago(1) },
    });
    await cap.handle!(tick(), makeCtx(world));

    expect(world.writes).toContainEqual({
      owner: "merchant@g1",
      item: "bread",
      qty: UNLIMITED_STOCK - (UNLIMITED_FLOOR - 1),
    });
  });

  it("advances the clock by whole intervals, not to now", async () => {
    // Advancing to `now` would discard the remainder and quietly slow the rate.
    const world = baseWorld({
      stock: { "merchant@g1": [{ item_id: "iron_ore", qty: 0 }] },
      restockedAt: { g1: ago(2) },
    });
    await cap.handle!(tick(), makeCtx(world));

    const stamped = new Date(world.stateWrites[0]!.value).getTime();
    expect(Date.now() - stamped).toBeGreaterThan(0);
    expect(Date.now() - stamped).toBeLessThan(RESTOCK_INTERVAL_MS);
  });

  it("ignores anything that isn't a minute tick", async () => {
    const world = baseWorld({ restockedAt: { g1: ago(5) } });
    await cap.handle!({ type: "trade.completed" } as unknown as BusEvent, makeCtx(world));

    expect(world.queries).toEqual([]);
  });
});

describe("never-empty tokens (§5.12 permit sinks)", () => {
  const tokenCap = restockCapability({ unlimitedItems: ["build_permit"] });

  it("refills an emptied permit immediately, with no interval to wait for", async () => {
    // An empty permit sink fails every build in the realm, so it cannot wait an
    // hour — and it hangs off the BARE bot id, not a continent.
    const world = baseWorld({ stock: { merchant: [{ item_id: "build_permit", qty: 0 }] } });
    await tokenCap.handle!(tick(), makeCtx(world));

    expect(world.writes).toEqual([{ owner: "merchant", item: "build_permit", qty: UNLIMITED_STOCK }]);
  });

  it("leaves a healthy permit alone", async () => {
    const world = baseWorld({ stock: { merchant: [{ item_id: "build_permit", qty: UNLIMITED_STOCK }] } });
    await tokenCap.handle!(tick(), makeCtx(world));

    expect(world.writes).toEqual([]);
  });
});
