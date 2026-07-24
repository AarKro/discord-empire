/**
 * Architect — the research bot (framework spec §4 roster, §5). Trades as its
 * manifest id and "sells" research permits (the cost sink); world:init seeds that
 * NPC + the research catalog.
 *
 * Capabilities (see manifests/architect.yaml): trade, topology, research, notify,
 * commands. `/research` with node autocomplete → prereq & cost guards → ledger
 * deduction (via `trade`) → per-player timed research; the tick service fires
 * research.completed → blueprints granted → notify. `/techtree` answers directly
 * from the DB with the player's progress.
 *
 * The generic runner (core's runBot) owns the lifecycle; this entrypoint only
 * supplies the manifest and the slash-command defs, whose autocomplete/resolve
 * bodies are live SQL and so are inherently code, not YAML.
 */
import { runBot, rootLogger, type CommandDef } from "@empire/core";

interface CatalogRow {
  id: string;
  name: string;
  cost_gold: number;
  prereqs: string[];
  grants_blueprints: string[];
}

/** Node ids the player has already completed — the set every prereq must be in. */
async function doneSet(sql: CommandContext["sql"], userId: string): Promise<Set<string>> {
  const rows = await sql<{ research_id: string }[]>`
    SELECT research_id FROM research WHERE owner_id = ${userId} AND status = 'done'
  `;
  return new Set(rows.map((r) => r.research_id));
}

type CommandContext = Parameters<NonNullable<CommandDef["autocomplete"]>>[0];

const commands: CommandDef[] = [
  {
    name: "research",
    description: "Begin a research project",
    route: "research.requested",
    options: [{ name: "node", description: "What to research", autocomplete: true, required: true }],
    // Offer only AVAILABLE nodes: not already done/underway, and every prereq met.
    autocomplete: async (ctx, typed, userId) => {
      const like = `%${typed.toLowerCase()}%`;
      const rows = await ctx.sql<CatalogRow[]>`
        SELECT id, name, cost_gold, prereqs, grants_blueprints FROM research_catalog
        WHERE (lower(name) LIKE ${like} OR lower(id) LIKE ${like})
          AND id NOT IN (
            SELECT research_id FROM research
            WHERE owner_id = ${userId} AND status IN ('done', 'in_progress')
          )
        ORDER BY cost_gold ASC
      `;
      const done = await doneSet(ctx.sql, userId);
      return rows
        .filter((r) => r.prereqs.every((p) => done.has(p)))
        .slice(0, 25)
        .map((r) => ({ name: `${r.name} (${r.cost_gold}g)`, value: r.id }));
    },
  },
  {
    name: "techtree",
    description: "Your research progress",
    route: "",
    resolve: async (ctx, { userId }) => {
      const nodes = await ctx.sql<CatalogRow[]>`
        SELECT id, name, cost_gold, prereqs, grants_blueprints FROM research_catalog ORDER BY cost_gold ASC
      `;
      if (nodes.length === 0) return "The archives are empty — no research to pursue yet.";
      const states = await ctx.sql<{ research_id: string; status: string }[]>`
        SELECT research_id, status FROM research WHERE owner_id = ${userId}
      `;
      const status = new Map(states.map((s) => [s.research_id, s.status]));
      const done = new Set([...status].filter(([, s]) => s === "done").map(([id]) => id));
      const line = (r: CatalogRow): string => {
        const st = status.get(r.id);
        if (st === "done") return `✅ ${r.name}`;
        if (st === "in_progress") return `⏳ ${r.name} (underway)`;
        const missing = r.prereqs.filter((p) => !done.has(p));
        if (missing.length > 0) return `🔒 ${r.name} — needs ${missing.join(", ")}`;
        return `▫️ ${r.name} (${r.cost_gold}g) — available`;
      };
      return "**Research tree**\n" + nodes.map(line).join("\n");
    },
  },
];

runBot({ manifest: "manifests/architect.yaml", configs: { commands } }).catch((err) => {
  rootLogger.error({ err }, "architect crashed");
  process.exit(1);
});
