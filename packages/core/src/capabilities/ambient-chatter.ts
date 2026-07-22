/**
 * ambient.chatter (framework spec §5.8) — scheduled/randomized flavor posts in
 * location chats plus reactions to world events. When a reacted-to event fires
 * (e.g. a traveler's world.rumor), a framing line is posted into the guild's
 * bazaar text chat, weaving in the event's own `hint` when it carries one — so
 * the townsfolk visibly gossip about what's happening in the world. Throttled
 * per guild so a burst of events in one continent doesn't spam its chat while
 * leaving other continents free to react.
 */
import type { Capability, CapabilityContext } from "../capability.js";
import { locationChannel } from "../locations.js";
import { payloadString } from "../events.js";

export interface ChatterConfig {
  /** event type -> candidate framing lines to react with. */
  reactions: Record<string, string[]>;
  throttleMs?: number;
}

export function ambientChatterCapability(config: ChatterConfig): Capability {
  const throttle = config.throttleMs ?? 30_000;
  /** guildId -> last post time, so the throttle is per-location (§5.8). */
  const lastAtByGuild = new Map<string, number>();
  return {
    name: "ambient.chatter",
    consumes: ["world.", "npc.arrived", "trade.completed"],
    actions: {},
    async handle(evt, ctx: CapabilityContext): Promise<void> {
      const lines = config.reactions[evt.type];
      if (!lines || lines.length === 0) return;
      // A line has to land somewhere — skip events that carry no location.
      const guildId = evt.guildId;
      if (!guildId) return;

      const now = Date.now();
      if (now - (lastAtByGuild.get(guildId) ?? 0) < throttle) return;
      lastAtByGuild.set(guildId, now);

      const channelId = await locationChannel(ctx.sql, guildId, "bazaar");
      if (!channelId) {
        ctx.logger.warn({ guildId }, "no bazaar channel for ambient chatter — run world:init");
        return;
      }

      // The framing line sets the tone; the event's own rumour hint (when present)
      // delivers the actual news. Events without a hint just post the framing line.
      const line = lines[Math.floor(Math.random() * lines.length)]!;
      const hint = payloadString(evt, "hint");
      const content = hint ? `*${line}* ${hint}` : line;

      await ctx.gateway.sendToChannel(channelId, { content });
      ctx.logger.debug({ trigger: evt.type, guildId, line }, "ambient chatter posted");
    },
  };
}
