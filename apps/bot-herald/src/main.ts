/**
 * Herald — player world-navigation bot (framework spec §9). Owns the /travel
 * slash command: its autocomplete offers the continents reachable from where the
 * player stands (ring neighbours in continents.yaml), and the invocation routes a
 * travel.requested event into the player_travel workflow, which the `wayfare`
 * capability drives across an in-transit leg (see manifests/herald.yaml).
 *
 * The generic runner (core's runBot) owns the lifecycle; this entrypoint supplies
 * the manifest and the /travel command def, whose autocomplete is live SQL + the
 * continent ring and so is code, not YAML.
 */
import { join } from "node:path";
import { runBot, rootLogger, type CommandDef } from "@empire/core";
import { loadContentFile, Continents } from "@empire/content-schemas";

const CONTENT_DIR = process.env.CONTENT_DIR ?? "content";
const continents = loadContentFile(Continents, join(CONTENT_DIR, "continents.yaml"));

// /travel <continent> — a round-trip command (autocomplete → travel.requested →
// player_travel workflow → command.reply). Offers only reachable neighbours; the
// wayfare.depart verb re-validates the hop, so a crafted value is still rejected.
const commands: CommandDef[] = [
  {
    name: "travel",
    description: "Set out for a neighbouring continent",
    route: "travel.requested",
    options: [{ name: "continent", description: "Where to journey", autocomplete: true, required: true }],
    autocomplete: async (ctx, typed, userId) => {
      const [row] = await ctx.sql<{ position_guild_id: string | null }[]>`
        SELECT position_guild_id FROM players WHERE discord_user_id = ${userId}
      `;
      const current = row?.position_guild_id ?? null;
      // Reachable = ring neighbours of where you stand; an unregistered player
      // (no position) is offered every continent (depart validates on the way out).
      const reachable = current ? (continents.continents[current]?.neighbors ?? []) : Object.keys(continents.continents);
      const like = typed.toLowerCase();
      return reachable
        .map((guildId) => ({ value: guildId, name: continents.continents[guildId]?.name ?? guildId }))
        .filter((choice) => choice.name.toLowerCase().includes(like))
        .slice(0, 25);
    },
  },
];

runBot({ manifest: "manifests/herald.yaml", configs: { commands } }).catch((err) => {
  rootLogger.error({ err }, "herald crashed");
  process.exit(1);
});
