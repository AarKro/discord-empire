/**
 * Builder — reference bot #2 (framework spec §4 roster, §10 validation path).
 *
 * Capabilities (see manifests/builder.yaml): trade, topology, land, notify,
 * commands. `/build` with blueprint autocomplete → cost & position guards →
 * ledger deduction (via `trade`) → per-player build-queue instance with a
 * tier-scaled timer; the tick service fires build.completed → notify per player.
 *
 * The generic runner (core's runBot) owns the lifecycle; this entrypoint only
 * supplies the manifest and the slash-command defs, whose autocomplete/resolve
 * bodies are live SQL and so are inherently code, not YAML.
 */
import { runBot, rootLogger, BUILD_PERMIT_ITEM, type CommandDef } from "@empire/core";

// §5.10, §10 Builder. /build is a round-trip (guards → trade → queue → ephemeral
// reply); /balance and /inventory answer directly from the DB.
const commands: CommandDef[] = [
  {
    name: "build",
    description: "Queue a building on your land",
    route: "build.requested",
    options: [{ name: "blueprint", description: "What to build", autocomplete: true, required: true }],
    autocomplete: async (ctx, typed) => {
      const like = `%${typed.toLowerCase()}%`;
      const rows = await ctx.sql<{ id: string; name: string; cost_gold: number }[]>`
        SELECT id, name, cost_gold FROM blueprint_catalog
        WHERE lower(name) LIKE ${like} OR lower(id) LIKE ${like}
        ORDER BY cost_gold ASC LIMIT 25
      `;
      return rows.map((r) => ({ name: `${r.name} (${r.cost_gold}g)`, value: r.id }));
    },
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
      // build_permit is an internal cost-modeling token (the builder "sells" it
      // to charge for a build); it must never surface in the player's packs.
      const rows = await ctx.sql<{ item_id: string; qty: number }[]>`
        SELECT item_id, qty FROM inventories
        WHERE owner_kind = 'player' AND owner_id = ${userId} AND qty > 0 AND item_id <> ${BUILD_PERMIT_ITEM}
        ORDER BY item_id ASC
      `;
      if (rows.length === 0) return "Your packs are empty.";
      return "You carry:\n" + rows.map((r) => `• ${r.qty}× ${r.item_id}`).join("\n");
    },
  },
];

runBot({ manifest: "manifests/builder.yaml", configs: { commands } }).catch((err) => {
  rootLogger.error({ err }, "builder crashed");
  process.exit(1);
});
