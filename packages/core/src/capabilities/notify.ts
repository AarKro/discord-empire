/**
 * notify (framework spec §5.9) — receipts & pings. Posts to the player's land
 * channel by default; DMs opt-in via /settings notifications. Fallback chain:
 * preferred target -> land channel -> skip with log. This capability runs in the
 * bot process, so it delivers straight through the gateway rather than emitting
 * a render event (the builder bot has no render surface).
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
 * land channel → skip with log. DM delivery is not wired yet, so an opted-in DM
 * still resolves to the land channel. When no land channel exists (plot not yet
 * provisioned), skip-with-log is the expected outcome — the contract, not a bug.
 */
async function deliver(ctx: CapabilityContext, playerId: string, message: string): Promise<void> {
  const prefs = await prefsFor(ctx, playerId);
  // DM delivery isn't wired yet (arrives with /settings notifications); an
  // opted-in DM falls through to the land channel — the next link in the chain.
  if (prefs.dm && prefs.target === "dm") {
    ctx.logger.info({ playerId }, "notify: DM not yet supported; falling back to land channel");
  }
  // Land plot lookup resolves the concrete channel in the bot process. Exclude
  // pruned plots — their channel is deleted/archived — so we target the live one.
  const [plot] = await ctx.sql<{ text_channel_id: string | null }[]>`
    SELECT text_channel_id FROM land_plots WHERE owner_id = ${playerId} AND pruned = false LIMIT 1
  `;
  if (!plot?.text_channel_id) {
    ctx.logger.warn({ playerId }, "notify: no land channel; skipping (fallback exhausted)");
    return;
  }
  await ctx.gateway.sendToChannel(plot.text_channel_id, message);
  ctx.logger.info({ playerId, channel: plot.text_channel_id }, "notify delivered");
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
