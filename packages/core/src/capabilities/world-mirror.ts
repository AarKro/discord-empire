/**
 * world.mirror (framework spec §9 cross-guild actions) — the Herald's town-crier.
 * A `world.announce` event is realm-global, not tied to the continent it fired on:
 * this capability fans its ready-to-post `message` out to EVERY continent's
 * #town-crier channel (locations kind='crier'), so an auction result or a
 * realm-wide notice reaches all shores at once.
 *
 * Deliberately dumb about content — producers render the line and emit
 * `world.announce`; any future world.* announcement (leaderboard sweeps, event
 * openings) reuses the same fan-out without touching the mirror. Mounted on the
 * Herald alone, so a single process does the cross-guild broadcast (§9).
 */
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";
import { payloadString } from "../events.js";

export function worldMirrorCapability(): Capability {
  return {
    name: "world.mirror",
    consumes: ["world.announce"],
    actions: {},
    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      const message = payloadString(evt, "message");
      if (!message) return;
      // Every continent's crier — the DB is the guild→channel truth (§8), so this
      // works for however many continents world:init has seeded.
      const criers = await ctx.sql<{ channel_id: string | null }[]>`
        SELECT channel_id FROM locations WHERE kind = 'crier'
      `;
      let posted = 0;
      for (const crier of criers) {
        if (!crier.channel_id) continue;
        // Isolate each continent: a deleted channel or a missing SEND perm on one
        // crier must not abort the broadcast to the others.
        try {
          await ctx.gateway.sendToChannel(crier.channel_id, { content: message });
          posted += 1;
        } catch (err) {
          ctx.logger.warn({ err, channelId: crier.channel_id }, "crier broadcast failed for one continent");
        }
      }
      ctx.logger.info({ posted, total: criers.length, type: evt.type }, "world announcement mirrored to criers");
    },
  };
}
