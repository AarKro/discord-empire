/**
 * presence.voice (framework spec §5.1) — NPC location & wandering. NPC-only,
 * player-locked voice channels form the visible world map. One voice connection
 * per guild ("one place at a time" per continent). At boot the NPC joins its
 * home voice channel self-muted (the gateway holds the actual @discordjs/voice
 * connection); the DB position + events remain the authoritative, testable core.
 * Following npc.move to other channels is a later pass.
 */
import type { Capability, CapabilityContext } from "../capability.js";
import { jsonParam } from "@empire/db";

export function presenceVoiceCapability(): Capability {
  return {
    name: "presence.voice",
    consumes: ["npc.move", "tick.hour"],

    /** Join the home voice channel (kind='voice', seeded by world:init) per guild. */
    async init(ctx: CapabilityContext): Promise<void> {
      for (const guildId of ctx.personas.guildIds) {
        const [loc] = await ctx.sql<{ channel_id: string | null }[]>`
          SELECT channel_id FROM locations WHERE guild_id = ${guildId} AND kind = 'voice' LIMIT 1
        `;
        if (!loc?.channel_id) {
          ctx.logger.warn({ guildId }, "no home voice channel mapped — run world:init; skipping voice presence");
          continue;
        }
        await ctx.gateway.joinVoice(guildId, loc.channel_id);
      }
    },

    actions: {
      "npc.move_to": async (args, evt, ctx: CapabilityContext) => {
        const guildId = evt?.guildId ?? ctx.personas.guildIds[0]!;
        const channel = String(args.channel);
        await ctx.sql`UPDATE npcs SET state = jsonb_set(state, '{channel}', ${jsonParam(ctx.sql, channel)})
                      WHERE id = ${ctx.bot}`;
        await ctx.bus.publish({
          type: "npc.arrived",
          guildId,
          subject: { kind: "npc", id: ctx.bot },
          payload: { channel },
        });
        ctx.logger.info({ guildId, channel }, "npc moved");
      },
    },
  };
}
