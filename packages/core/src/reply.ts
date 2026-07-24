/**
 * Answering a player's slash command (framework spec §5.10).
 *
 * A round-trip command holds its deferred ephemeral reply in the `commands`
 * capability, keyed by correlation id, and settles it when a RESULT event with
 * that correlation arrives. Any capability can therefore answer a command it
 * didn't receive, simply by publishing the right envelope — which four
 * capabilities were each re-deriving inline.
 *
 * The envelope is the load-bearing part: `actor` is the player (so the reply
 * routes back to them), `subject` is this bot (so the broadcast bus doesn't
 * settle another bot's pending reply — see notForMe), and `correlationId` is
 * what pairs it with the waiting interaction. Getting any of those wrong is a
 * silently-unanswered command, so it lives in one place.
 */
import type { CapabilityContext } from "./capability.js";

/** The envelope fields a reply inherits from the event that triggered it. */
export interface ReplySource {
  guildId?: string | null;
  correlationId?: string | null;
}

/**
 * Publish a player-facing reply event of `type`, carrying `message`. Used for
 * `command.reply` and for the domain-specific rejection types the `commands`
 * capability also settles on (build.rejected, research.rejected).
 */
export async function publishReply(
  ctx: CapabilityContext,
  type: string,
  evt: ReplySource | null | undefined,
  player: string,
  message: string,
): Promise<void> {
  await ctx.bus.publish({
    type,
    guildId: evt?.guildId ?? null,
    actor: { kind: "player", id: player },
    subject: { kind: "npc", id: ctx.bot },
    payload: { message },
    correlationId: evt?.correlationId ?? null,
  });
}

/**
 * Settle a round-trip slash command with an in-fiction line — the generic
 * channel (`command.reply`) any command can answer on.
 */
export function replyToCommand(
  ctx: CapabilityContext,
  evt: ReplySource | null | undefined,
  player: string,
  message: string,
): Promise<void> {
  return publishReply(ctx, "command.reply", evt, player, message);
}
