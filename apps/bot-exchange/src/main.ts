/**
 * Exchange — the player market bot (framework spec §5.11). Hosts the player-to-
 * player commerce commands and owns the per-continent Marketplace board:
 *   /trade @player <side> <item> <qty> <price>  — a contact-gated direct offer
 *   /stall <item> <qty> <price>                 — list a ware on the board
 *   /unstall <item>                             — pull your listing
 *   /caravan <destination>                      — post an agent on another continent
 *   /recall <destination>                       — call that caravan home
 * The generic runner owns the lifecycle; the `market` and `caravan` capabilities
 * (in @empire/core) do the work. Autocomplete is live SQL over the caller's
 * inventory / discoveries / postings, so it's code, not YAML.
 */
import { join } from "node:path";
import { runBot, rootLogger, buildMarketOverviewEmbed, HIDDEN_ITEMS, type CommandDef } from "@empire/core";
import { loadContentFile, Continents } from "@empire/content-schemas";

/** Continent metadata (names, ring) for the cross-continent /market browse. */
const continents = loadContentFile(Continents, join(process.env.CONTENT_DIR ?? "content", "continents.yaml"));

/** Suggest items the caller actually holds (what they can sell / list). Internal
 * cost/hold tokens are excluded so they can't be traded, listed, or auctioned —
 * HIDDEN_ITEMS is the shared list (see core's world/items.ts). */
const itemAutocomplete: CommandDef["autocomplete"] = async (ctx, typed, userId) => {
  const like = `%${typed.toLowerCase()}%`;
  const rows = await ctx.sql<{ item_id: string; qty: number }[]>`
    SELECT item_id, qty FROM inventories
    WHERE owner_kind = 'player' AND owner_id = ${userId} AND qty > 0
      AND item_id <> ALL(${HIDDEN_ITEMS}) AND lower(item_id) LIKE ${like}
    ORDER BY item_id ASC LIMIT 25
  `;
  return rows.map((r) => ({ name: `${r.item_id} (${r.qty})`, value: r.item_id }));
};

/**
 * Continents a caravan may be posted to: everywhere the player has DISCOVERED
 * except where they already stand — you don't need an agent in the market you're
 * in. Suggesting only discovered shores keeps the command from spoiling the map.
 */
const continentAutocomplete: CommandDef["autocomplete"] = async (ctx, typed, userId) => {
  const rows = await ctx.sql<{ guild_id: string }[]>`
    SELECT d.guild_id FROM continent_discoveries d
    JOIN players p ON p.discord_user_id = d.player_id
    WHERE d.player_id = ${userId} AND d.guild_id <> p.home_guild_id
    ORDER BY d.guild_id ASC LIMIT 25
  `;
  // Names live in content, not the DB, so the typed filter is applied here.
  const needle = typed.toLowerCase();
  return rows
    .map((r) => ({ name: continents.continents[r.guild_id]?.name ?? r.guild_id, value: r.guild_id }))
    .filter((c) => c.name.toLowerCase().includes(needle));
};

/** Only the continents this player actually has a caravan standing on. */
const postedCaravanAutocomplete: CommandDef["autocomplete"] = async (ctx, _typed, userId) => {
  const rows = await ctx.sql<{ destination: string }[]>`
    SELECT mission->>'destination_guild_id' AS destination FROM dispatches
    WHERE owner_id = ${userId} AND status = 'stationed' AND mission->>'kind' = 'caravan'
    LIMIT 25
  `;
  return rows
    .filter((r) => r.destination)
    .map((r) => ({ name: continents.continents[r.destination]?.name ?? r.destination, value: r.destination }));
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
  {
    name: "auction",
    description: "Open a timed auction for an item on the Marketplace",
    route: "auction.list.requested",
    options: [
      { name: "item", description: "The item to auction", autocomplete: true, required: true },
      { name: "qty", description: "How many", required: true },
      { name: "starting_price", description: "Reserve / opening bid (total gold)", required: true },
      { name: "duration", description: "Minutes until it closes", required: true },
    ],
    autocomplete: itemAutocomplete,
  },
  {
    name: "caravan",
    description: "Post a caravan on another continent to trade there (§2.3 an agent on site)",
    route: "caravan.requested",
    options: [{ name: "destination", description: "Which continent to post it to", autocomplete: true, required: true }],
    autocomplete: continentAutocomplete,
  },
  {
    name: "recall",
    description: "Call a posted caravan home",
    route: "caravan.recall.requested",
    options: [{ name: "destination", description: "Which caravan to recall", autocomplete: true, required: true }],
    autocomplete: postedCaravanAutocomplete,
  },
  {
    name: "market",
    description: "Browse the markets and your open positions",
    route: "",
    resolve: async (ctx, { userId }) => ({
      embeds: [(await buildMarketOverviewEmbed(ctx.sql, continents, userId)).toJSON()],
    }),
  },
];

runBot({ manifest: "manifests/exchange.yaml", configs: { commands } }).catch((err) => {
  rootLogger.error({ err }, "exchange crashed");
  process.exit(1);
});
