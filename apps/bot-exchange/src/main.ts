/**
 * Exchange — the player market bot (framework spec §5.11). Hosts the player-to-
 * player commerce commands and owns the per-continent Marketplace board:
 *   /trade @player <side> <item> <qty> <price>  — a contact-gated direct offer
 *   /stall <item> <qty> <price>                 — list a ware on the board
 *   /unstall <item>                             — pull your listing
 * The generic runner owns the lifecycle; the `market` capability (in @empire/core)
 * does the work. Item autocomplete is live SQL over the caller's inventory, so
 * it's code, not YAML.
 */
import { runBot, rootLogger, type CommandDef } from "@empire/core";

/** Suggest items the caller actually holds (what they can sell / list). */
const itemAutocomplete: CommandDef["autocomplete"] = async (ctx, typed, userId) => {
  const like = `%${typed.toLowerCase()}%`;
  const rows = await ctx.sql<{ item_id: string; qty: number }[]>`
    SELECT item_id, qty FROM inventories
    WHERE owner_kind = 'player' AND owner_id = ${userId} AND qty > 0 AND lower(item_id) LIKE ${like}
    ORDER BY item_id ASC LIMIT 25
  `;
  return rows.map((r) => ({ name: `${r.item_id} (${r.qty})`, value: r.item_id }));
};

const commands: CommandDef[] = [
  {
    name: "trade",
    description: "Offer a direct trade to a player you've met",
    route: "offer.direct.requested",
    options: [
      { name: "player", description: "Who to trade with (@mention)", required: true },
      { name: "side", description: "sell (to them) or buy (from them)", required: true },
      { name: "item", description: "The item", autocomplete: true, required: true },
      { name: "qty", description: "How many", required: true },
      { name: "price", description: "Total gold", required: true },
    ],
    autocomplete: itemAutocomplete,
  },
  {
    name: "stall",
    description: "List an item for sale on the Marketplace",
    route: "stall.list.requested",
    options: [
      { name: "item", description: "The item to sell", autocomplete: true, required: true },
      { name: "qty", description: "How many", required: true },
      { name: "price", description: "Total gold", required: true },
    ],
    autocomplete: itemAutocomplete,
  },
  {
    name: "unstall",
    description: "Pull your listing of an item from the Marketplace",
    route: "stall.unlist.requested",
    options: [{ name: "item", description: "The item to unlist", autocomplete: true, required: true }],
    autocomplete: itemAutocomplete,
  },
];

runBot({ manifest: "manifests/exchange.yaml", configs: { commands } }).catch((err) => {
  rootLogger.error({ err }, "exchange crashed");
  process.exit(1);
});
