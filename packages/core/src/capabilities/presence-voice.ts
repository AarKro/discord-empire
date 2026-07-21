/**
 * presence.voice (framework spec §5.1) — NPC location & wandering. NPC-only,
 * player-locked voice channels form the visible world map. One voice connection
 * per guild ("one place at a time" per continent).
 *
 * At boot the NPC joins the first stop of its wander route (or its home voice
 * channel if it has no route) self-muted. Wandering itself is now driven by a
 * declarative workflow (§7, e.g. merchant_wander): it composes this capability's
 * `npc.move_to` verb on a timer, which connects voice, records the DB position,
 * and announces npc.arrived so the stall re-opens and voicelines fire. The
 * gateway holds the actual @discordjs/voice connection; the DB position + events
 * remain the authoritative, testable core.
 *
 * Logical stop names (e.g. "bazaar_vc") resolve to real voice channels via the
 * `locations` rows world:init seeds (id = `<name>_<guildId>`, kind='voice').
 */
import type { Capability, CapabilityContext } from "../capability.js";
import { locationChannel } from "../locations.js";
import { jsonParam } from "@empire/db";

/** One stop on an NPC's wander route: a logical voice-channel name in a guild. */
export interface WanderStop {
  guildId: string;
  channel: string;
}

export function presenceVoiceCapability(route: WanderStop[] = []): Capability {
  // Group the route by guild, preserving order; track the current stop per guild.
  const stopsByGuild = new Map<string, string[]>();
  for (const stop of route) {
    const list = stopsByGuild.get(stop.guildId) ?? [];
    list.push(stop.channel);
    stopsByGuild.set(stop.guildId, list);
  }

  /** Resolve a logical stop name to its Discord voice channel id (world:init map). */
  async function resolveChannel(ctx: CapabilityContext, guildId: string, channel: string): Promise<string | null> {
    const [location] = await ctx.sql<{ channel_id: string | null }[]>`
      SELECT channel_id FROM locations WHERE id = ${`${channel}_${guildId}`} AND kind = 'voice' LIMIT 1
    `;
    return location?.channel_id ?? null;
  }

  /**
   * Move the NPC to a logical stop: connect voice, record the DB position, and
   * (when announcing) publish npc.arrived so the stall/voicelines react. Boot
   * uses announce=false because the bot process emits its own arrival ping.
   */
  async function moveTo(ctx: CapabilityContext, guildId: string, channel: string, announce: boolean): Promise<void> {
    const channelId = await resolveChannel(ctx, guildId, channel);
    if (!channelId) {
      ctx.logger.warn({ guildId, channel }, "no voice channel mapped for stop — run world:init");
      return;
    }
    const joined = await ctx.gateway.joinVoice(guildId, channelId);
    if (!joined) return;
    await ctx.sql`UPDATE npcs SET state = jsonb_set(state, '{channel}', ${jsonParam(ctx.sql, channel)})
                  WHERE id = ${ctx.bot}`;
    if (announce) {
      await ctx.bus.publish({
        type: "npc.arrived",
        guildId,
        subject: { kind: "npc", id: ctx.bot },
        payload: { channel },
      });
    }
    ctx.logger.info({ guildId, channel }, "npc moved");
  }

  return {
    name: "presence.voice",
    // Movement is workflow-driven (via the npc.move_to action); this capability
    // no longer reacts to bus events itself, only boots position and exports verbs.
    consumes: [],

    /** Take up the first stop per guild (or the home voice channel if no route). */
    async init(ctx: CapabilityContext): Promise<void> {
      for (const guildId of ctx.personas.guildIds) {
        const stops = stopsByGuild.get(guildId);
        if (stops && stops.length > 0) {
          await moveTo(ctx, guildId, stops[0]!, false);
          continue;
        }
        // No wander route here — just stand in the guild's home voice channel.
        const channelId = await locationChannel(ctx.sql, guildId, "voice", { orderById: true });
        if (channelId) await ctx.gateway.joinVoice(guildId, channelId);
        else ctx.logger.warn({ guildId }, "no voice channel mapped — run world:init; skipping voice presence");
      }
    },

    actions: {
      "npc.move_to": async (args, evt, ctx: CapabilityContext) => {
        const guildId = ctx.personas.homeGuild(evt?.guildId);
        await moveTo(ctx, guildId, String(args.channel), true);
      },
    },
  };
}
