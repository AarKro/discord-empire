/**
 * Unit tests for the caravan verbs the `caravan` workflow (§7, §11) composes.
 * Postgres and Discord are faked, in the same style as combat.test.ts — what's
 * asserted is the guards, the SQL each verb decides to run, and the plain-data
 * events it publishes.
 *
 * The properties worth the most here are the ones only a live server would
 * otherwise expose: that the escort is tied up and freed by id, that a
 * redelivered tick can't post or close a caravan twice, that a stale Buy button
 * can't trade through a caravan that has gone home — and that the stall in the
 * player's land wears the CARAVAN's face, never the source merchant's (§11: you
 * are dealing with your own caravan).
 *
 * The settled purchase itself is `executeTrade`'s contract, covered against a
 * real ledger in packages/db; here the buy path is exercised up to its guards.
 */
import { describe, it, expect } from "vitest";
import { caravanCapability, CARAVAN_MISSION } from "../src/capabilities/caravan.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";
import type { ComponentInteraction } from "../src/gateway/index.js";
import type { Continents, Shop } from "@empire/content-schemas";

const SHOP: Shop = {
  id: "aldric_wares",
  currency: "gold",
  items: [
    { item_id: "bread", name: "Loaf of Bread", base_price: 5, stock: 100 },
    { item_id: "iron_ore", name: "Iron Ore", base_price: 38, stock: 4 },
  ],
};

const CONTINENTS: Continents = {
  continents: {
    g1: { name: "Continent One", order: 1, neighbors: ["g2"] },
    g2: { name: "The Thornwild", order: 2, neighbors: ["g1"] },
  },
};

interface Published {
  type: string;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
}

interface World {
  /** crossContinentCommerceBlock inputs. */
  home: string;
  researched: boolean;
  built: boolean;
  /** An idle troop stack to escort the caravan (null = none). */
  escort: { id: string; qty: number; unit_type: string } | null;
  /** A caravan already on that road. */
  existingCaravan: boolean;
  /** Row the guarded travelling→stationed UPDATE returns (null = redelivered). */
  arriveRow?: Record<string, unknown> | null;
  /** Row the guarded stationed→returning UPDATE returns (null = nothing posted). */
  recallRow?: Record<string, unknown> | null;
  /** Row the guarded returning→done UPDATE returns (null = redelivered). */
  returnRow?: Record<string, unknown> | null;
  /** What loadDispatch finds for a Buy click. */
  dispatch?: Record<string, unknown> | null;
  npcSeeded: boolean;
  landChannel: string | null;
  published: Published[];
  queries: string[];
  /** Messages the gateway was asked to upsert, with their rendered payload. */
  upserts: { channel: string; existing: string | null; json: string }[];
}

function baseWorld(over: Partial<World> = {}): World {
  return {
    home: "g1",
    researched: true,
    built: true,
    escort: { id: "unit_1", qty: 4, unit_type: "infantry" },
    existingCaravan: false,
    npcSeeded: true,
    landChannel: "land_g1",
    published: [],
    queries: [],
    upserts: [],
    ...over,
  };
}

const STATIONED = {
  id: "dsp_1",
  owner_id: "u1",
  mission: { kind: CARAVAN_MISSION, destination_guild_id: "g2" },
  origin_guild_id: "g1",
  status: "stationed",
};

function makeCtx(world: World): CapabilityContext {
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    world.queries.push(q);
    // Order matters: the narrower dispatch statements are matched before the
    // generic SELECT that shares their prefix.
    if (q.includes("UPDATE dispatches SET status = 'stationed'")) return Promise.resolve(world.arriveRow ? [world.arriveRow] : []);
    if (q.includes("UPDATE dispatches SET status = 'returning'")) return Promise.resolve(world.recallRow ? [world.recallRow] : []);
    if (q.includes("UPDATE dispatches SET status = 'done'")) return Promise.resolve(world.returnRow ? [world.returnRow] : []);
    if (q.includes("SELECT id FROM dispatches")) return Promise.resolve(world.existingCaravan ? [{ id: "dsp_old" }] : []);
    if (q.includes("FROM dispatches") && q.includes("WHERE id = ")) return Promise.resolve(world.dispatch ? [world.dispatch] : []);
    if (q.includes("FROM dispatches") && q.includes("status = 'stationed'")) return Promise.resolve(world.dispatch ? [world.dispatch] : []);
    if (q.includes("FROM npcs")) return Promise.resolve(world.npcSeeded ? [{ id: "merchant" }] : []);
    if (q.includes("FROM inventories")) return Promise.resolve([{ item_id: "bread", qty: 7 }, { item_id: "iron_ore", qty: 0 }]);
    if (q.includes("FROM land_plots")) return Promise.resolve(world.landChannel ? [{ text_channel_id: world.landChannel }] : []);
    if (q.includes("FROM players")) return Promise.resolve([{ home_guild_id: world.home }]);
    if (q.includes("FROM research")) return Promise.resolve(world.researched ? [{ one: 1 }] : []);
    if (q.includes("FROM build_queue")) return Promise.resolve(world.built ? [{ one: 1 }] : []);
    if (q.includes("FROM units")) return Promise.resolve(world.escort ? [world.escort] : []);
    return Promise.resolve([]);
  };
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = (): Promise<unknown[]> => Promise.resolve([]);
    return fn(tx);
  };
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log };
  return {
    bot: "exchange",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: Published) => {
        world.published.push(input);
        return input as never;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: {
      upsertPinnedMessage: async (channel: string, existing: string | null, content: unknown) => {
        world.upserts.push({ channel, existing, json: JSON.stringify(content) });
        return "msg_1";
      },
      onComponent: () => {},
    } as unknown as CapabilityContext["gateway"],
    personas: {
      guildIds: ["g1"],
      homeGuild: (g?: string | null) => g ?? "g1",
    } as unknown as CapabilityContext["personas"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

function evt(over: Partial<BusEvent> & { type: string }): BusEvent {
  return {
    dbId: "1",
    eventId: "e1",
    ts: "",
    guildId: "g1",
    actor: { kind: "player", id: "u1" },
    subject: { kind: "npc", id: "exchange" },
    payload: {},
    correlationId: "cmd_1",
    ...over,
  };
}

const cap = caravanCapability(SHOP, CONTINENTS);
function verb(name: string, e: BusEvent, ctx: CapabilityContext) {
  return cap.actions[name]!({}, e, ctx);
}
const send = (e: BusEvent, ctx: CapabilityContext) => verb("caravan.send", e, ctx);
const sendEvt = (destination: string) => evt({ type: "caravan.requested", payload: { destination } });

describe("caravan.send guards (§2.3 the first two gates only)", () => {
  it("posts the caravan and ties up exactly one escort stack", async () => {
    const world = baseWorld();
    const ctx = makeCtx(world);
    await send(sendEvt("g2"), ctx);

    expect(world.queries.some((q) => q.includes("INSERT INTO dispatches"))).toBe(true);
    // The escort is tied up by id — never a blanket "this player's idle troops".
    expect(world.queries.some((q) => q.includes("UPDATE units SET status = 'dispatched' WHERE id = ANY("))).toBe(true);
    const sent = world.published.find((p) => p.type === "caravan.sent");
    expect(sent).toBeDefined();
    expect(sent!.payload).toMatchObject({ destination: "g2" });
    expect(sent!.correlationId).toBe("cmd_1");
  });

  it("records the mission as a caravan on the shared dispatch table (§5.13)", async () => {
    const world = baseWorld();
    const ctx = makeCtx(world);
    await send(sendEvt("g2"), ctx);

    // A new mission KIND, not a new table — the schema comment's prediction.
    const insert = world.queries.find((q) => q.includes("INSERT INTO dispatches"))!;
    expect(insert).toContain("dispatches");
    expect(world.queries.some((q) => q.includes("CREATE TABLE"))).toBe(false);
  });

  it("refuses an unknown continent", async () => {
    const world = baseWorld();
    const ctx = makeCtx(world);
    await expect(send(sendEvt("nowhere"), ctx)).rejects.toThrow();

    expect(world.published.map((p) => p.type)).toEqual(["caravan.rejected"]);
    expect(world.queries.some((q) => q.includes("INSERT INTO dispatches"))).toBe(false);
  });

  it("refuses to post an agent on the continent the player already stands on", async () => {
    const world = baseWorld();
    const ctx = makeCtx(world);
    await expect(send(sendEvt("g1"), ctx)).rejects.toThrow();

    expect(world.published[0]!.payload!.message).toContain("no caravan needed");
  });

  it("refuses without trade_routes research, pointing at the Architect (§2.3)", async () => {
    const world = baseWorld({ researched: false });
    const ctx = makeCtx(world);
    await expect(send(sendEvt("g2"), ctx)).rejects.toThrow();

    expect(world.published[0]!.payload!.message).toContain("Architect");
    expect(world.queries.some((q) => q.includes("INSERT INTO dispatches"))).toBe(false);
  });

  it("refuses without a Trade Post, pointing at the Builder (§2.3)", async () => {
    const world = baseWorld({ built: false });
    const ctx = makeCtx(world);
    await expect(send(sendEvt("g2"), ctx)).rejects.toThrow();

    expect(world.published[0]!.payload!.message).toContain("Builder");
  });

  it("refuses a second caravan on the same road", async () => {
    const world = baseWorld({ existingCaravan: true });
    const ctx = makeCtx(world);
    await expect(send(sendEvt("g2"), ctx)).rejects.toThrow();

    expect(world.published[0]!.payload!.message).toContain("already have a caravan");
  });

  it("refuses when no troops stand idle to escort it (§2.6 troops are the send-someone mechanic)", async () => {
    const world = baseWorld({ escort: null });
    const ctx = makeCtx(world);
    await expect(send(sendEvt("g2"), ctx)).rejects.toThrow();

    expect(world.published[0]!.payload!.message).toContain("muster");
    expect(world.queries.some((q) => q.includes("INSERT INTO dispatches"))).toBe(false);
  });
});

describe("caravan.arrive (§2.3 the agent takes up its post)", () => {
  const arrived = () => evt({ type: "dispatch.arrived", payload: { dispatch_id: "dsp_1" } });

  it("stations the caravan and posts its stall to the home land plot", async () => {
    const world = baseWorld({ arriveRow: STATIONED });
    const ctx = makeCtx(world);
    await verb("caravan.arrive", arrived(), ctx);

    // The stall goes to the plot on the ORIGIN continent, not the destination.
    expect(world.upserts).toHaveLength(1);
    expect(world.upserts[0]!.channel).toBe("land_g1");
    expect(world.published.map((p) => p.type)).toEqual(["caravan.stationed"]);
  });

  it("wears the caravan's persona and never names the source merchant (§11)", async () => {
    const world = baseWorld({ arriveRow: STATIONED });
    const ctx = makeCtx(world);
    await verb("caravan.arrive", arrived(), ctx);

    const rendered = world.upserts[0]!.json;
    expect(rendered).toContain("Your Caravan");
    expect(rendered).toContain("The Thornwild");
    // Gameplay-wise the player is dealing with their own caravan: nothing of
    // Aldric's identity may leak into their land.
    expect(rendered).not.toContain("Aldric");
    expect(rendered).not.toContain("aldric");
  });

  it("offers the merchant's live stock, disabling what's sold out", async () => {
    const world = baseWorld({ arriveRow: STATIONED });
    const ctx = makeCtx(world);
    await verb("caravan.arrive", arrived(), ctx);

    const rendered = JSON.parse(world.upserts[0]!.json) as { components: { components: { custom_id: string; disabled: boolean }[] }[] };
    const buttons = rendered.components.flatMap((row) => row.components);
    expect(buttons.map((b) => b.custom_id)).toEqual(["crv:buy:dsp_1:bread", "crv:buy:dsp_1:iron_ore"]);
    // iron_ore is at qty 0 in the fake inventory.
    expect(buttons.map((b) => b.disabled)).toEqual([false, true]);
  });

  it("cannot be posted twice by a redelivered tick", async () => {
    const world = baseWorld({ arriveRow: null });
    const ctx = makeCtx(world);
    await verb("caravan.arrive", arrived(), ctx);

    expect(world.upserts).toEqual([]);
    expect(world.published).toEqual([]);
  });

  it("claims only caravan missions, leaving a battle in flight alone (§5.13)", async () => {
    const world = baseWorld({ arriveRow: STATIONED });
    const ctx = makeCtx(world);
    await verb("caravan.arrive", arrived(), ctx);

    // The tick sweeps every travelling dispatch, so the kind is what keeps this
    // verb off the Warden's rows.
    expect(world.queries.some((q) => q.includes("UPDATE dispatches SET status = 'stationed'") && q.includes("mission->>'kind'"))).toBe(true);
  });
});

describe("the caravan's wares (§11 no haggling, and no ledger writes here)", () => {
  function interaction(over: Partial<ComponentInteraction> = {}): ComponentInteraction & { replies: string[] } {
    const replies: string[] = [];
    return {
      customId: "crv:buy:dsp_1:bread",
      values: [],
      userId: "u1",
      guildId: "g1",
      channelId: "land_g1",
      replies,
      reply: async (message: string) => {
        replies.push(message);
      },
      ...over,
    } as unknown as ComponentInteraction & { replies: string[] };
  }

  /** Drive a Buy click through the component router the capability registers. */
  async function click(world: World, over: Partial<ComponentInteraction> = {}) {
    let handler: ((i: ComponentInteraction) => Promise<void>) | null = null;
    const ctx = makeCtx(world);
    (ctx.gateway as unknown as { onComponent: (h: (i: ComponentInteraction) => Promise<void>) => void }).onComponent = (h) => {
      handler = h;
    };
    cap.init!(ctx);
    const i = interaction(over);
    await handler!(i);
    return { i, world };
  }

  it("refuses a stale button once the caravan has gone home", async () => {
    const world = baseWorld({ dispatch: { ...STATIONED, status: "returning" } });
    const { i } = await click(world);

    expect(i.replies[0]).toContain("left that market");
    expect(world.queries.some((q) => /INSERT INTO (ledger|balances|inventories)/.test(q))).toBe(false);
  });

  it("refuses someone else's caravan", async () => {
    const world = baseWorld({ dispatch: STATIONED });
    const { i } = await click(world, { userId: "u2" });

    expect(i.replies[0]).toContain("answers to someone else");
  });

  it("refuses when the dispatch isn't a caravan at all", async () => {
    const world = baseWorld({ dispatch: { ...STATIONED, mission: { kind: "battle" } } });
    const { i } = await click(world);

    expect(i.replies[0]).toContain("no longer yours");
  });

  it("never writes the economy tables itself — settlement is executeTrade's job", async () => {
    const world = baseWorld({ dispatch: STATIONED, npcSeeded: false });
    const { i } = await click(world);

    expect(i.replies[0]).toContain("No trade is moving");
    expect(world.queries.some((q) => /INSERT INTO (ledger|balances|inventories)/.test(q))).toBe(false);
  });
});

describe("recall and return (§2.3 the posting is a standing investment)", () => {
  it("starts the journey home and closes the stall down", async () => {
    const world = baseWorld({ recallRow: { ...STATIONED, mission: { ...STATIONED.mission, stall_message_id: "msg_1" } } });
    const ctx = makeCtx(world);
    await cap.handle!(evt({ type: "caravan.recall.requested", payload: { destination: "g2" } }), ctx);

    expect(world.queries.some((q) => q.includes("UPDATE dispatches SET status = 'returning'"))).toBe(true);
    // The stall is edited to a closed notice with no buttons, not left live.
    expect(world.upserts).toHaveLength(1);
    expect(world.upserts[0]!.existing).toBe("msg_1");
    expect(JSON.parse(world.upserts[0]!.json).components).toEqual([]);
    expect(world.published.map((p) => p.type)).toEqual(["command.reply"]);
  });

  it("says so when nothing is posted there", async () => {
    const world = baseWorld({ recallRow: null });
    const ctx = makeCtx(world);
    await cap.handle!(evt({ type: "caravan.recall.requested", payload: { destination: "g2" } }), ctx);

    expect(world.published[0]!.payload!.message).toContain("no caravan posted there");
    expect(world.upserts).toEqual([]);
  });

  it("frees exactly the escort it took", async () => {
    const world = baseWorld({
      returnRow: { owner_id: "u1", force: { champion: null, troops: [{ unitId: "unit_1" }] } },
    });
    const ctx = makeCtx(world);
    await verb("caravan.return", evt({ type: "dispatch.returned", payload: { dispatch_id: "dsp_1" } }), ctx);

    expect(world.queries.some((q) => q.includes("UPDATE units SET status = 'idle' WHERE id = ANY("))).toBe(true);
    expect(world.published.map((p) => p.type)).toEqual(["notify.requested"]);
  });

  it("cannot be returned twice by a redelivered tick", async () => {
    const world = baseWorld({ returnRow: null });
    const ctx = makeCtx(world);
    await verb("caravan.return", evt({ type: "dispatch.returned", payload: { dispatch_id: "dsp_1" } }), ctx);

    expect(world.published).toEqual([]);
    expect(world.queries.some((q) => q.includes("UPDATE units SET status = 'idle'"))).toBe(false);
  });
});
