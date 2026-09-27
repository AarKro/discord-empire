/**
 * Builder — reference bot #2 (framework spec §4 roster, §10 validation path).
 *
 * Capabilities (see manifests/builder.yaml): trade, topology, land, notify,
 * commands. `/collect` banks what finished buildings produced. `/build` with blueprint autocomplete → cost & position guards →
 * ledger deduction (via `trade`) → per-player build-queue instance with a
 * tier-scaled timer; the tick service fires build.completed → notify per player.
 *
 * The generic runner (core's runBot) owns the lifecycle; this entrypoint only
 * supplies the manifest and the slash-command defs, whose autocomplete/resolve
 * bodies are live SQL and so are inherently code, not YAML.
 */
import { join } from "node:path";
import { runBot, rootLogger, HIDDEN_ITEMS, BUILD_PERMIT_ITEM, collectProductionFor, progressReport, type CommandDef } from "@empire/core";
import { loadContentFile, Tiers } from "@empire/content-schemas";

/** Tier milestones (§2.5), for /progress. The same file `progression` promotes by. */
const tiers = loadContentFile(Tiers, join(process.env.CONTENT_DIR ?? "content", "tiers.yaml"));

// §5.10, §10 Builder. /build is a round-trip (guards → trade → queue → ephemeral
// reply); /collect, /balance and /inventory answer directly from the DB.
const commands: CommandDef[] = [
  {
    name: "build",
    description: "Queue a building on your land",
    route: "build.requested",
    options: [{ name: "blueprint", description: "What to build", autocomplete: true, required: true }],
    autocomplete: async (ctx, typed, userId) => {
      const like = `%${typed.toLowerCase()}%`;
      const rows = await ctx.sql<{ id: string; name: string; cost_gold: number }[]>`
        SELECT id, name, cost_gold FROM blueprint_catalog
        WHERE lower(name) LIKE ${like} OR lower(id) LIKE ${like}
        ORDER BY cost_gold ASC
      `;
      // Gate research-locked recipes (§4 Architect): a blueprint granted by some
      // research node only appears once the player owns it (via /research).
      // Ungated recipes (farm/forge) always show. Filter then cap at 25.
      const gatedRows = await ctx.sql<{ grants_blueprints: string[] }[]>`SELECT grants_blueprints FROM research_catalog`;
      const gated = new Set(gatedRows.flatMap((r) => r.grants_blueprints));
      const ownedRows = await ctx.sql<{ blueprint_id: string }[]>`SELECT blueprint_id FROM blueprints WHERE owner_id = ${userId}`;
      const owned = new Set(ownedRows.map((r) => r.blueprint_id));
      return rows
        .filter((r) => !gated.has(r.id) || owned.has(r.id))
        .slice(0, 25)
        .map((r) => ({ name: `${r.name} (${r.cost_gold}g)`, value: r.id }));
    },
  },
  {
    // §2.4 the idle loop: bank what your buildings have produced.
    name: "collect",
    description: "Gather what your buildings have produced",
    route: "",
    resolve: async (ctx, { userId }) => collectProductionFor(ctx.sql, userId),
  },
  {
    // §2.5: your tier and what the next one asks.
    name: "progress",
    description: "Your tier, and what it takes to rise",
    route: "",
    resolve: async (ctx, { userId }) => progressReport(ctx.sql, userId, tiers),
  },
  {
    name: "balance",
    description: "How much coin you carry",
    route: "",
    resolve: async (ctx, { userId }) => {
      const [bal] = await ctx.sql<{ amount: number }[]>`
        SELECT amount FROM balances
        WHERE owner_kind = 'player' AND owner_id = ${userId} AND currency = 'gold'
      `;
      return `You carry **${bal?.amount ?? 0} gold**.`;
    },
  },
  {
    name: "inventory",
    description: "What you own",
    route: "",
    resolve: async (ctx, { userId }) => {
      // Internal cost/hold tokens (build & research permits, the auction hold)
      // are economy plumbing, not possessions, so they must never surface in the
      // player's packs. HIDDEN_ITEMS is the single list — filtering by hand here
      // is how research_permit and auction_bid leaked into view.
      const rows = await ctx.sql<{ item_id: string; qty: number }[]>`
        SELECT item_id, qty FROM inventories
        WHERE owner_kind = 'player' AND owner_id = ${userId} AND qty > 0
          AND item_id <> ALL(${HIDDEN_ITEMS})
        ORDER BY item_id ASC
      `;
      if (rows.length === 0) return "Your packs are empty.";
      return "You carry:\n" + rows.map((r) => `• ${r.qty}× ${r.item_id}`).join("\n");
    },
  },
];

runBot({
  manifest: "manifests/builder.yaml",
  // The build permit is an accounting token, not a ware. If its stock ever hit
  // zero, executeTrade's guard would refuse every /build in the realm with
  // "sorry, just sold out!" — so `restock` keeps it topped (§5.12).
  configs: { commands, restock: { unlimitedItems: [BUILD_PERMIT_ITEM] } },
}).catch((err) => {
  rootLogger.error({ err }, "builder crashed");
  process.exit(1);
});
