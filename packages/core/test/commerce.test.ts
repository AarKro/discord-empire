/**
 * Unit tests for the cross-continent commerce guard (§2.3). Postgres is faked; we
 * assert the eligibility decision (null = allowed, string = in-fiction reason) for
 * each combination of home continent, research, and Trade Post building.
 */
import { describe, it, expect } from "vitest";
import { crossContinentCommerceBlock } from "../src/world/commerce.js";
import type { Sql } from "@empire/db";

interface World {
  home: string | null; // null = no player row
  researched: boolean;
  built: boolean;
}

/** A tagged-template sql fake keyed on the query text (values ignored, as elsewhere). */
function fakeSql(world: World): Sql {
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM players")) return Promise.resolve(world.home ? [{ home_guild_id: world.home }] : []);
    if (q.includes("FROM research")) return Promise.resolve(world.researched ? [{ one: 1 }] : []);
    if (q.includes("FROM build_queue")) return Promise.resolve(world.built ? [{ one: 1 }] : []);
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

  it("allows cross-continent commerce once research AND a Trade Post are in hand", async () => {
    expect(await crossContinentCommerceBlock(fakeSql({ home: "g1", researched: true, built: true }), "u1", "g2")).toBeNull();
  });
});
