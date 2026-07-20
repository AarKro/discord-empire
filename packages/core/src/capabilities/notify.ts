/**
 * notify (framework spec §5.9) — receipts & pings. Posts to the player's land
 * channel/thread by default; DMs opt-in via /settings notifications. Fallback
 * chain: preferred target -> land thread -> skip with log.
 */
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";

export interface NotifyPrefs {
  target: "land" | "dm";
  dm: boolean;
}

async function prefsFor(ctx: CapabilityContext, playerId: string): Promise<NotifyPrefs> {
  const [row] = await ctx.sql<{ notification_prefs: NotifyPrefs }[]>`
    SELECT notification_prefs FROM players WHERE discord_user_id = ${playerId}
  `;
  return row?.notification_prefs ?? { target: "land", dm: false };
}

/**
 * Deliver a notification via the fallback chain (§5.9): preferred target →
 * land thread → skip with log. In iteration-1 dev the land channel is usually
 * absent, so a skip-with-log is the expected outcome — the contract, not a bug.
 */
async function deliver(ctx: CapabilityContext, playerId: string, message: string): Promise<void> {
  const prefs = await prefsFor(ctx, playerId);
  const target = prefs.dm && prefs.target === "dm" ? "dm" : "land";
  // Land plot lookup resolves the concrete channel in the bot process.
  const [plot] = await ctx.sql<{ text_channel_id: string | null }[]>`
    SELECT text_channel_id FROM land_plots WHERE owner_id = ${playerId} LIMIT 1
  `;
  if (target === "land" && !plot?.text_channel_id) {
    ctx.logger.warn({ playerId }, "notify: no land channel; skipping (fallback exhausted)");
    return;
  }
  ctx.logger.info({ playerId, target }, "notify delivered");
  await ctx.bus.publish({
    type: "notify.delivered",
    actor: { kind: "player", id: playerId },
    payload: { target, message },
  });
}

export function notifyCapability(): Capability {
  return {
    name: "notify",
    consumes: ["build.completed", "research.completed"],
    actions: {
      "notify.player": async (args, _evt, ctx: CapabilityContext) => {
        await deliver(ctx, String(args.player), String(args.message));
      },
    },

    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      if (evt.type !== "build.completed" || !evt.actor) return;
      const blueprint = String((evt.payload as { blueprint?: unknown }).blueprint ?? "your building");
      await deliver(ctx, evt.actor.id, `Your ${blueprint} is complete!`);
    },
  };
}
