/**
 * Catalog sync (§1.3 content as data). The buildable recipes, the research tree
 * and the bestiary are authored in content/catalog/*.yaml and upserted into
 * their tables on boot by the capability that owns them — `land`, `research`
 * and `combat` respectively.
 *
 * The YAML is the source of truth, so an existing row is OVERWRITTEN with the
 * file's values (a tuning change ships by editing a file and restarting). Rows
 * are never deleted: an in-flight build, research node or dispatch may still
 * reference an id that was dropped from the file, and the catalog is what it
 * resolves against.
 *
 * These tables are game definitions, not economy, so writing them here does not
 * touch the ledger invariant.
 */
import type { Blueprints, Encounters, ResearchTree } from "@empire/content-schemas";
import { jsonParam, type Sql } from "@empire/db";

export async function syncBlueprints(sql: Sql, catalog: Blueprints): Promise<void> {
  for (const b of catalog.blueprints) {
    await sql`
      INSERT INTO blueprint_catalog (id, name, cost_gold, base_ms, produces, max_count, unlock_item)
      VALUES (${b.id}, ${b.name}, ${b.cost_gold}, ${b.base_ms},
              ${b.produces ? jsonParam(sql, b.produces) : null}, ${b.max}, ${b.unlock_item ?? null})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, cost_gold = EXCLUDED.cost_gold, base_ms = EXCLUDED.base_ms,
        produces = EXCLUDED.produces, max_count = EXCLUDED.max_count, unlock_item = EXCLUDED.unlock_item
    `;
  }
}

export async function syncResearch(sql: Sql, tree: ResearchTree): Promise<void> {
  for (const n of tree.research) {
    await sql`
      INSERT INTO research_catalog (id, name, cost_gold, base_ms, prereqs, grants_blueprints)
      VALUES (${n.id}, ${n.name}, ${n.cost_gold}, ${n.base_ms},
              ${jsonParam(sql, n.prereqs)}, ${jsonParam(sql, n.grants_blueprints)})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, cost_gold = EXCLUDED.cost_gold, base_ms = EXCLUDED.base_ms,
        prereqs = EXCLUDED.prereqs, grants_blueprints = EXCLUDED.grants_blueprints
    `;
  }
}

export async function syncEncounters(sql: Sql, bestiary: Encounters): Promise<void> {
  for (const e of bestiary.encounters) {
    await sql`
      INSERT INTO encounter_catalog (id, name, unit_type, atk, def, hp, tier, travel_ms, loot, reward_gold)
      VALUES (${e.id}, ${e.name}, ${e.unit_type}, ${e.atk}, ${e.def}, ${e.hp},
              ${e.tier}, ${e.travel_ms}, ${jsonParam(sql, e.loot)}, ${e.reward_gold})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, unit_type = EXCLUDED.unit_type, atk = EXCLUDED.atk, def = EXCLUDED.def,
        hp = EXCLUDED.hp, tier = EXCLUDED.tier, travel_ms = EXCLUDED.travel_ms, loot = EXCLUDED.loot,
        reward_gold = EXCLUDED.reward_gold
    `;
  }
}
