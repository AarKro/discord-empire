/**
 * presence.voice (framework spec §5.1) — NPC location & wandering. NPC-only,
 * player-locked voice channels form the visible world map. One voice connection
 * per guild ("one place at a time" per continent). Emits npc.arrived /
 * npc.departed / npc.traveling. Actual @discordjs/voice joins are exercised on
 * dev servers; DB position + events are the authoritative, testable core.
 */
import type { Capability, CapabilityContext } from "../capability.js";
import { jsonParam } from "@empire/db";

export function presenceVoiceCapability(): Capability {
  return {
    name: "presence.voice",
    consumes: ["npc.move", "tick.hour"],
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
