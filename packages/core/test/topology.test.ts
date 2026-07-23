/**
 * Unit tests for intra-continent travel (§2.3) on the topology capability:
 * district.depart validates the ring hop, clears the district ("walking"), and
 * confirms via command.reply; district.arrive records position + discovery and
 * grants the district's Discord view-role (the RTS reveal). Postgres (incl.
 * arrive's transaction) and the gateway are faked.
 */
import { describe, it, expect } from "vitest";
import { topologyCapability, requiresPresence } from "../src/capabilities/topology.js";
import type { Sql } from "@empire/db";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";

interface World {
  guild: string | null;
  district: string | null;
  neighborsOf: Record<string, string[]>;
  meta: Record<string, { name: string; view_role_id: string | null }>;
  replies: string[];
  discovered: string[];
  grants: { guildId: string; roleId: string }[];
  discoveries: string[];
}

function makeCtx(world: World): CapabilityContext {
  const P = (rows: unknown[]) => Promise.resolve(rows);
  const fn = (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("position_guild_id FROM players")) return P([{ position_guild_id: world.guild }]);
    if (q.includes("position_district_id FROM players")) return P([{ position_district_id: world.district }]);
    if (q.includes("UPDATE players SET position_guild_id")) { world.guild = (vals[0] as string) ?? null; world.district = (vals[1] as string) ?? null; return P([]); }
    if (q.includes("UPDATE players SET position_district_id")) { world.district = (vals[0] as string) ?? null; return P([]); }
    if (q.includes("view_role_id")) { const m = world.meta[String(vals[0])]; return P(m ? [{ view_role_id: m.view_role_id, name: m.name }] : []); }
    if (q.includes("neighbors FROM districts")) return P([{ neighbors: world.neighborsOf[String(vals[0])] ?? [] }]);
    if (q.includes("FROM districts")) { const m = world.meta[String(vals[0])]; return P(m ? [{ name: m.name }] : []); }
    if (q.includes("INSERT INTO discoveries")) { world.discoveries.push(String(vals[1])); return P([]); }
    return P([]); // co-presence others / contacts inserts
  };
  const sql = Object.assign(fn, { begin: async (cb: (tx: unknown) => unknown) => cb(sql) });
  return {
    bot: "herald",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: { type: string; payload?: { message?: string; district?: string } }) => {
        if (input.type === "command.reply") world.replies.push(input.payload!.message!);
        if (input.type === "district.discovered") world.discovered.push(input.payload!.district!);
        return undefined;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: { grantRole: async (guildId: string, _userId: string, roleId: string) => { world.grants.push({ guildId, roleId }); } } as unknown as CapabilityContext["gateway"],
    personas: {} as unknown as CapabilityContext["personas"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
}

const evt = (): BusEvent => ({
  dbId: "0", eventId: "e", type: "district.move.requested", ts: "", guildId: "g1",
  actor: { kind: "player", id: "p1" }, subject: { kind: "npc", id: "herald" }, payload: {}, correlationId: "cmd_1",
});

function freshWorld(): World {
  return {
    guild: "g1",
    district: "market_g1",
    neighborsOf: { market_g1: ["farmlands_g1"] },
    meta: { farmlands_g1: { name: "The Farmlands", view_role_id: "role_farm" } },
    replies: [], discovered: [], grants: [], discoveries: [],
  };
}

// A fake sql serving one locations row + one players row, for requiresPresence.
type LocRow = { guild_id: string; district_id: string | null; requires_presence: boolean } | null;
type PlayerRow = { position_guild_id: string | null; position_district_id: string | null } | null;
function presenceSql(location: LocRow, player: PlayerRow): Sql {
  const fn = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM locations")) return Promise.resolve(location ? [location] : []);
    if (q.includes("FROM players")) return Promise.resolve(player ? [player] : []);
    return Promise.resolve([]);
  };
  return fn as unknown as Sql;
}

describe("requiresPresence — the hard presence gate (§2.3)", () => {
  const bazaar = (district: string | null): LocRow => ({ guild_id: "g1", district_id: district, requires_presence: true });

  it("is present when the player stands in the location's guild AND district", async () => {
    const r = await requiresPresence(presenceSql(bazaar("market_g1"), { position_guild_id: "g1", position_district_id: "market_g1" }), "p1", "bazaar_g1");
    expect(r.present).toBe(true);
  });

  it("refuses when the player is on the right continent but the WRONG district (the §2.2 gate)", async () => {
    const r = await requiresPresence(presenceSql(bazaar("market_g1"), { position_guild_id: "g1", position_district_id: "farmlands_g1" }), "p1", "bazaar_g1");
    expect(r.present).toBe(false);
    expect(r.reason).toContain("walk from where you stand");
  });

  it("ignores district when the location has none (continent-level gate)", async () => {
    const r = await requiresPresence(presenceSql(bazaar(null), { position_guild_id: "g1", position_district_id: "anywhere" }), "p1", "bazaar_g1");
    expect(r.present).toBe(true);
  });

  it("refuses a player on another continent entirely", async () => {
    const r = await requiresPresence(presenceSql(bazaar("market_g1"), { position_guild_id: "g2", position_district_id: "market_g2" }), "p1", "bazaar_g1");
    expect(r.present).toBe(false);
  });

  it("is always present at a location that doesn't gate", async () => {
    const r = await requiresPresence(presenceSql({ guild_id: "g1", district_id: "market_g1", requires_presence: false }, { position_guild_id: "g2", position_district_id: null }), "p1", "bazaar_g1");
    expect(r.present).toBe(true);
  });

  it("refuses in-fiction for a missing place / unplaced player", async () => {
    expect((await requiresPresence(presenceSql(null, null), "p1", "nowhere")).reason).toContain("no such place");
    expect((await requiresPresence(presenceSql(bazaar("market_g1"), null), "p1", "bazaar_g1")).reason).toContain("nowhere yet");
  });
});

describe("topology — intra-continent travel (§2.3)", () => {
  it("district.depart clears the district and confirms for a valid neighbour", async () => {
    const world = freshWorld();
    await topologyCapability().actions["district.depart"]!({ district: "farmlands_g1" }, evt(), makeCtx(world));
    expect(world.district).toBeNull(); // walking
    expect(world.replies[0]).toContain("The Farmlands");
  });

  it("district.depart rejects a non-neighbour: reply + throw (→ on_error)", async () => {
    const world = freshWorld();
    const run = topologyCapability().actions["district.depart"]!({ district: "harbourside_g1" }, evt(), makeCtx(world));
    await expect(run).rejects.toThrow();
    expect(world.district).toBe("market_g1"); // unchanged
    expect(world.replies[0]).toContain("no path");
  });

  it("district.depart rejects a player already walking (null district)", async () => {
    const world = freshWorld();
    world.district = null;
    const run = topologyCapability().actions["district.depart"]!({ district: "farmlands_g1" }, evt(), makeCtx(world));
    await expect(run).rejects.toThrow();
    expect(world.replies[0]).toContain("already on the move");
  });

  it("district.arrive records position + discovery and grants the view-role", async () => {
    const world = freshWorld();
    world.district = null; // was walking
    await topologyCapability().actions["district.arrive"]!({ district: "farmlands_g1" }, evt(), makeCtx(world));
    expect(world.district).toBe("farmlands_g1");
    expect(world.discoveries).toEqual(["farmlands_g1"]);
    expect(world.grants).toEqual([{ guildId: "g1", roleId: "role_farm" }]);
    expect(world.discovered).toEqual(["farmlands_g1"]);
  });
});
