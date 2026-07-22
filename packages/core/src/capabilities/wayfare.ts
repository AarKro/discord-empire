/**
 * wayfare (framework spec §9) — PLAYER travel between continents. The player-facing
 * counterpart to the NPC `travel` capability: a /travel command triggers the
 * player_travel workflow, which composes these verbs across an in-transit leg.
 * Travel is guild-level (districts are unseeded in iteration 1): a player leaves
 * their continent (position cleared — "on the road"), and after the transit timer
 * arrives on a neighbouring continent (position set). The continent ring in
 * continents.yaml gates which hops are legal.
 *
 * Position is pure DB state on `players` (§2.3); Discord only reflects it — and
 * now the presence gate (requiresPresence) actually enforces "trade where you
 * stand" once you've moved.
 */
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";
import type { Continents } from "@empire/content-schemas";
import { locationChannel } from "../locations.js";
import { ensurePlayer } from "@empire/db";

export function wayfareCapability(continents: Continents): Capability {
  /** Resolve the ephemeral /travel reply (a generic command.reply the commands cap settles). */
  async function reply(ctx: CapabilityContext, evt: BusEvent | null, player: string, message: string): Promise<void> {
    await ctx.bus.publish({
      type: "command.reply",
      guildId: evt?.guildId ?? null,
      actor: { kind: "player", id: player },
      subject: { kind: "npc", id: ctx.bot },
      payload: { message },
      correlationId: evt?.correlationId ?? null,
    });
  }

  return {
    name: "wayfare",
    consumes: [],
    actions: {
      /**
       * Set out for a neighbouring continent: auto-register the player, validate
       * the hop against the ring, clear position ("on the road"), and confirm via
       * the ephemeral reply. A known-bad hop replies with the reason THEN throws so
       * the workflow's on_error routes to `rejected` (a bare final state) without
       * arming the transit timer.
       */
      "wayfare.depart": async (args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        const destination = String(args.destination ?? "");

        // Auto-register on first interaction (§2.1); home = the guild /travel ran in.
        await ensurePlayer(ctx.sql, player, ctx.personas.homeGuild(evt?.guildId));

        const [row] = await ctx.sql<{ position_guild_id: string | null }[]>`
          SELECT position_guild_id FROM players WHERE discord_user_id = ${player}
        `;
        const current = row?.position_guild_id ?? null;
        if (!current) {
          // Null position = mid-transit — one journey at a time.
          await reply(ctx, evt, player, "You're already on the road, friend — one journey at a time.");
          throw new Error("already travelling");
        }

        const neighbors = continents.continents[current]?.neighbors ?? [];
        if (!destination || !neighbors.includes(destination)) {
          await reply(ctx, evt, player, "There's no road that way from here.");
          throw new Error("invalid destination");
        }

        await ctx.sql`
          UPDATE players SET position_guild_id = ${null}, position_district_id = ${null}
          WHERE discord_user_id = ${player}
        `;
        const name = continents.continents[destination]?.name ?? "distant shores";
        await reply(ctx, evt, player, `You set out for ${name} — you'll arrive in a few minutes.`);
        ctx.logger.info({ player, from: current, to: destination }, "player departed");
      },

      /**
       * Arrive on the destination continent (fired by the transit timer): set
       * position and post a public arrival line into that continent's bazaar
       * (travellers may have no land, so notify's land-channel path won't do).
       */
      "wayfare.arrive": async (args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        const destination = String(args.destination ?? "");
        if (!destination) return;

        await ctx.sql`
          UPDATE players SET position_guild_id = ${destination}, position_district_id = ${null}
          WHERE discord_user_id = ${player}
        `;
        const name = continents.continents[destination]?.name ?? "a new shore";
        const channelId = await locationChannel(ctx.sql, destination, "bazaar");
        if (channelId) {
          await ctx.gateway.sendToChannel(channelId, {
            content: `*A weary traveller arrives in ${name}, the dust of the road still on their boots.*`,
          });
        }
        ctx.logger.info({ player, destination }, "player arrived");
      },
    },
  };
}
