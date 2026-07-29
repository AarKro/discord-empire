/**
 * Unit tests for the cross-continent commerce guard (§2.3). Postgres is faked; we
 * assert the eligibility decision (null = allowed, string = in-fiction reason) for
 * each combination of home continent, research, Trade Post building, and — the
 * third gate — a caravan actually standing in that market.
 */
import { describe, it, expect } from "vitest";
import { crossContinentCommerceBlock, tradeRoutesAndPostBlock } from "../src/world/commerce.js";
import type { Sql } from "@empire/db";

interface World {
  home: string | null; // null = no player row
  researched: boolean;
  built: boolean;
  /** A caravan stationed on the continent being reached into (§2.3 agent on site). */
  posted?: boolean;
}

/** A tagged-template sql fake keyed on the query text (values ignored, as elsewhere). */
function fakeSql(world: World): Sql {
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM players")) return Promise.resolve(world.home ? [{ home_guild_id: world.home }] : []);
    if (q.includes("FROM research")) return Promise.resolve(world.researched ? [{ one: 1 }] : []);
    if (q.includes("FROM build_queue")) return Promise.resolve(world.built ? [{ one: 1 }] : []);
    if (q.includes("FROM dispatches")) return Promise.resolve(world.posted ? [{ one: 1 }] : []);
    return Promise.resolve([]);
  };
  return sql as unknown as Sql;
}

describe("crossContinentCommerceBlock (§2.3)", () => {
  it("allows an offer with no continent", async () => {
    expect(await crossContinentCommerceBlock(fakeSql({ home: "g1", researched: false, built: false }), "u1", null)).toBeNull();
  });

  it("allows same-continent commerce with no research or building", async () => {
    expect(await crossContinentCommerceBlock(fakeSql({ home: "g1", researched: false, built: false }), "u1", "g1")).toBeNull();
  });

  it("treats an unregistered player's continent as home (nothing to gate)", async () => {
    expect(await crossContinentCommerceBlock(fakeSql({ home: null, researched: false, built: false }), "u1", "g2")).toBeNull();
  });

  it("blocks cross-continent commerce without trade_routes research (points at the Architect)", async () => {
    const msg = await crossContinentCommerceBlock(fakeSql({ home: "g1", researched: false, built: false }), "u1", "g2");
    expect(msg).toContain("Architect");
  });

  it("blocks cross-continent commerce with research but no Trade Post (points at the Builder)", async () => {
    const msg = await crossContinentCommerceBlock(fakeSql({ home: "g1", researched: true, built: false }), "u1", "g2");
    expect(msg).toContain("Builder");
  });

  it("still blocks with research AND a Trade Post but no agent on site (§2.3's third gate)", async () => {
    const msg = await crossContinentCommerceBlock(fakeSql({ home: "g1", researched: true, built: true, posted: false }), "u1", "g2");
    expect(msg).toContain("/caravan");
  });

  it("allows cross-continent commerce once a caravan is standing in that market", async () => {
    expect(
      await crossContinentCommerceBlock(fakeSql({ home: "g1", researched: true, built: true, posted: true }), "u1", "g2"),
    ).toBeNull();
  });

  it("never asks for a caravan on the player's own continent", async () => {
    // Same-continent deals short-circuit before the agent check, so a player with
    // no caravan anywhere can still trade at home.
    expect(await crossContinentCommerceBlock(fakeSql({ home: "g1", researched: false, built: false }), "u1", "g1")).toBeNull();
  });
});

describe("tradeRoutesAndPostBlock (§2.3, the gates that precede having an agent)", () => {
  it("passes on research + Trade Post alone, so a first caravan can be sent", async () => {
    // The full guard would demand an agent on site here; if caravan.send used it,
    // no player could ever send the caravan that satisfies it.
    expect(await tradeRoutesAndPostBlock(fakeSql({ home: "g1", researched: true, built: true, posted: false }), "u1", "g2")).toBeNull();
  });

  it("still enforces the two gates it owns", async () => {
    expect(await tradeRoutesAndPostBlock(fakeSql({ home: "g1", researched: false, built: false }), "u1", "g2")).toContain("Architect");
    expect(await tradeRoutesAndPostBlock(fakeSql({ home: "g1", researched: true, built: false }), "u1", "g2")).toContain("Builder");
  });
});
