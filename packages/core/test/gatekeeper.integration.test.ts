/**
 * Integration suite for the gatekeeper (§9): reconciliation runs the REAL SQL over
 * Postgres, with a fake gateway capturing `grantRole` calls. Proves Citizen@home +
 * Observer@discovered are granted (never undiscovered), that `gatekeeper.discover`
 * accumulates the discovered set, that a member joining "at the door" is registered
 * + reconciled, and that re-running is idempotent. Opt-in on TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle, assertMigrated } from "@empire/db";
import { gatekeeperCapability } from "../src/capabilities/gatekeeper.js";
import type { Capability, CapabilityContext } from "../src/runtime/capability.js";
import type { Continents } from "@empire/content-schemas";
import type { MemberJoin } from "../src/gateway/index.js";
import { rootLogger } from "../src/logger.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

const THREE: Continents = {
  continents: {
    g1: { name: "One", order: 1, neighbors: ["g2"] },
    g2: { name: "Two", order: 2, neighbors: ["g1", "g3"] },
    g3: { name: "Three", order: 3, neighbors: ["g2"] },
  },
};

interface Harness {
  cap: Capability;
  ctx: CapabilityContext;
  grants: { guildId: string; userId: string; roleId: string }[];
  join: (guildId: string, userId: string) => Promise<void>;
}

/** Build the gatekeeper over real sql + a fake gateway that records grants and captures the join hook. */
function setup(): Harness {
  const grants: Harness["grants"] = [];
  let joinHandler: (j: MemberJoin) => Promise<void> = async () => {};
  const ctx = {
    bot: "herald",
    sql: h.sql,
    bus: { publish: async () => undefined } as unknown as CapabilityContext["bus"],
    gateway: {
      grantRole: async (guildId: string, userId: string, roleId: string) => {
        grants.push({ guildId, userId, roleId });
      },
      onMemberJoin: (fn: (j: MemberJoin) => Promise<void>) => {
        joinHandler = fn;
      },
    } as unknown as CapabilityContext["gateway"],
    personas: {} as unknown as CapabilityContext["personas"],
    logger: rootLogger,
    config: {},
  } as CapabilityContext;
  const cap = gatekeeperCapability(THREE);
  void cap.init!(ctx);
  return { cap, ctx, grants, join: (guildId, userId) => joinHandler({ guildId, userId }) };
}

const discover = (h2: Harness, player: string, continent: string) =>
  h2.cap.actions["gatekeeper.discover"]!({ continent }, { actor: { id: player } } as never, h2.ctx);
const sweep = (h2: Harness) => h2.cap.actions["gatekeeper.sweep"]!({}, null, h2.ctx);

const has = (grants: Harness["grants"], guildId: string, userId: string, roleId: string) =>
  grants.some((g) => g.guildId === guildId && g.userId === userId && g.roleId === roleId);

async function seedPlayer(id: string, home: string) {
  await h.sql`INSERT INTO players (discord_user_id, home_guild_id, position_guild_id) VALUES (${id}, ${home}, ${home})`;
}

suite("gatekeeper — continent role reconciliation (§9)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 4 });
    await assertMigrated(h.sql);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.sql`TRUNCATE players, continent_roles, continent_discoveries, balances, ledger, locations RESTART IDENTITY CASCADE`;
    await h.sql`INSERT INTO continent_roles (guild_id, citizen_role_id, observer_role_id) VALUES
      ('g1','cit_g1','obs_g1'), ('g2','cit_g2','obs_g2'), ('g3','cit_g3','obs_g3')`;
  });

  it("sweep: Citizen at home + Observer at home's neighbour; nothing undiscovered", async () => {
    await seedPlayer("p1", "g1");
    const run = setup();
    await sweep(run);
    expect(has(run.grants, "g1", "p1", "cit_g1")).toBe(true); // Citizen at home
    expect(has(run.grants, "g2", "p1", "obs_g2")).toBe(true); // Observer at neighbour g2
    expect(run.grants.some((g) => g.guildId === "g3")).toBe(false); // g3 undiscovered → never granted
  });

  it("discover accumulates the set and grants the newly-watched continent", async () => {
    await seedPlayer("p1", "g1");
    const run = setup();
    await discover(run, "p1", "g2"); // arriving at g2 discovers g2 + neighbours(g2) = g1, g3

    // Observer set is now {g2, g3}; Citizen stays g1.
    expect(has(run.grants, "g1", "p1", "cit_g1")).toBe(true);
    expect(has(run.grants, "g2", "p1", "obs_g2")).toBe(true);
    expect(has(run.grants, "g3", "p1", "obs_g3")).toBe(true); // g3 now watched via g2's neighbours

    const rows = await h.sql<{ guild_id: string }[]>`SELECT guild_id FROM continent_discoveries WHERE player_id='p1' ORDER BY guild_id`;
    expect(rows.map((r) => r.guild_id)).toEqual(["g1", "g2", "g3"]);
  });

  it("member joining at the door registers a fresh player (home = joined guild) and reconciles", async () => {
    const run = setup();
    await run.join("g2", "p2"); // p2's first appearance is g2 → home g2

    const [p] = await h.sql<{ home_guild_id: string }[]>`SELECT home_guild_id FROM players WHERE discord_user_id='p2'`;
    expect(p?.home_guild_id).toBe("g2");
    expect(has(run.grants, "g2", "p2", "cit_g2")).toBe(true); // Citizen at new home g2
    expect(has(run.grants, "g1", "p2", "obs_g1")).toBe(true); // Observer at g2's neighbours g1, g3
    expect(has(run.grants, "g3", "p2", "obs_g3")).toBe(true);
  });

  it("re-running discover is idempotent — no duplicate discovery rows", async () => {
    await seedPlayer("p1", "g1");
    const run = setup();
    await discover(run, "p1", "g2");
    await discover(run, "p1", "g2");
    const [{ count }] = await h.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM continent_discoveries WHERE player_id='p1'`;
    expect(count).toBe(3); // g1, g2, g3 — not doubled
  });
});
