/**
 * Catalog sync (§1.3 content as data) against a REAL Postgres: the YAML is the
 * source of truth, so a boot must overwrite a row the file has since retuned —
 * the property that retired `world:init --force` for catalog changes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle, assertMigrated } from "@empire/db";
import { syncBlueprints, syncEncounters, syncResearch } from "../src/world/catalogs.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

suite("catalog sync (§1.3)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 2 });
    await assertMigrated(h.sql);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.sql`TRUNCATE blueprint_catalog, research_catalog, encounter_catalog`;
  });

  it("inserts new rows and overwrites retuned ones, deleting nothing", async () => {
    await h.sql`INSERT INTO blueprint_catalog (id, name, cost_gold, base_ms) VALUES ('farm', 'Old Farm', 999, 1), ('ruin', 'Ruin', 1, 1)`;
    await syncBlueprints(h.sql, { blueprints: [{ id: "farm", name: "Wheat Farm", cost_gold: 50, base_ms: 300000, max: 3 }] });
    const rows = await h.sql<{ id: string; name: string; cost_gold: number }[]>`
      SELECT id, name, cost_gold FROM blueprint_catalog ORDER BY id
    `;
    // `ruin` survives: something in flight may still reference it.
    expect(rows).toEqual([
      { id: "farm", name: "Wheat Farm", cost_gold: 50 },
      { id: "ruin", name: "Ruin", cost_gold: 1 },
    ]);
  });

  it("round-trips the jsonb columns of research and encounters", async () => {
    await syncResearch(h.sql, {
      research: [{ id: "masonry", name: "Masonry", cost_gold: 40, base_ms: 1, prereqs: [], grants_blueprints: ["granary"] }],
    });
    await syncEncounters(h.sql, {
      encounters: [
        {
          id: "moor_wolves", name: "Moor Wolves", unit_type: "cavalry", atk: 14, def: 4, hp: 90, tier: 1,
          travel_ms: 1, loot: [{ item: "wolf_pelt", qty: 2, chance: 0.8 }], reward_gold: 40,
        },
      ],
    });
    const [node] = await h.sql<{ grants_blueprints: string[] }[]>`SELECT grants_blueprints FROM research_catalog`;
    const [enc] = await h.sql<{ loot: unknown }[]>`SELECT loot FROM encounter_catalog`;
    expect(node!.grants_blueprints).toEqual(["granary"]);
    expect(enc!.loot).toEqual([{ item: "wolf_pelt", qty: 2, chance: 0.8 }]);
  });
});
