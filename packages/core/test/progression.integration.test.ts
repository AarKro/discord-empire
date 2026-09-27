/**
 * Tier promotion (§2.5) against a REAL Postgres: the milestone counts read the
 * right rows from three tables, and the conditional UPDATE promotes exactly once.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle, assertMigrated } from "@empire/db";
import { progressionCapability, milestoneCounts } from "../src/capabilities/progression.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";
import { rootLogger } from "../src/logger.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

const TIERS = { tiers: [{ tier: 2, name: "Settler", buildings: 2, research: 1, victories: 1 }] };

suite("progression (§2.5)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 2 });
    await assertMigrated(h.sql);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.sql`TRUNCATE players, build_queue, research, battles RESTART IDENTITY CASCADE`;
    await h.sql`INSERT INTO players (discord_user_id, home_guild_id) VALUES ('p1', 'g1')`;
  });

  it("counts only finished buildings, completed research and won battles, then promotes once", async () => {
    await h.sql`
      INSERT INTO build_queue (owner_id, plot_id, blueprint_id, status) VALUES
        ('p1', 'plot', 'farm', 'completed'), ('p1', 'plot', 'forge', 'completed'),
        ('p1', 'plot', 'granary', 'building'), ('p2', 'plot', 'farm', 'completed')
    `;
    await h.sql`INSERT INTO research (owner_id, research_id, status) VALUES ('p1', 'masonry', 'done'), ('p1', 'trade_routes', 'in_progress')`;
    await h.sql`
      INSERT INTO battles (id, dispatch_id, owner_id, encounter_id, seed, outcome, rounds, loot) VALUES
        ('b1', 'd1', 'p1', 'moor_wolves', 's', 'victory', '[]', '[]'),
        ('b2', 'd2', 'p1', 'moor_wolves', 's', 'defeat', '[]', '[]')
    `;
    expect(await milestoneCounts(h.sql, "p1")).toEqual({ buildings: 2, research: 1, victories: 1 });

    const published: string[] = [];
    const ctx = {
      bot: "builder",
      sql: h.sql,
      bus: { publish: async (e: { type: string }) => void published.push(e.type) },
      logger: rootLogger,
    } as unknown as CapabilityContext;
    const evt = { type: "build.finished", guildId: "g1", actor: { kind: "player", id: "p1" }, payload: {} } as unknown as BusEvent;
    const cap = progressionCapability(TIERS);
    await cap.handle!(evt, ctx);
    await cap.handle!(evt, ctx); // redelivered

    const [row] = await h.sql<{ tier: number }[]>`SELECT tier FROM players WHERE discord_user_id = 'p1'`;
    expect(row!.tier).toBe(2);
    expect(published).toEqual(["notify.requested", "world.announce"]);
  });
});
