/**
 * dialogue.thread (framework spec §5.4) — private per-player conversations.
 *
 * The tree engine is pure (../dialogue.ts); this capability drives it at
 * runtime: it keeps a per-player DialogueRunner session, opens on the stall's
 * Enter button (`stall.entered`), advances the tree on option clicks
 * (gateway components with `dlg:<option>` custom ids → `dialogue.choose`
 * events), publishes each node's text + guard-filtered options for rendering,
 * and publishes the option's emitted events (e.g. `trade.request`) with the
 * player as actor — which the trade capability consumes.
 */
import type { Dialogue } from "@empire/content-schemas";
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";
import { notForMe } from "../events.js";
import { ensurePlayer, DEFAULT_STARTING_GOLD } from "@empire/db";
import { DialogueRunner, loadGuardScope, DIALOGUE_OPTION_PREFIX, type GuardScope } from "../dialogue.js";

export { DIALOGUE_OPTION_PREFIX };

export function dialogueThreadCapability(tree: Dialogue): Capability {
  /** One live runner per player; created on open, dropped when the tree ends. */
  const sessions = new Map<string, DialogueRunner>();

  async function publishNode(
    type: "dialogue.opened" | "dialogue.node" | "dialogue.closed",
    playerId: string,
    runner: DialogueRunner,
    scope: GuardScope,
    ctx: CapabilityContext,
    guildId: string | null,
  ): Promise<void> {
    const options = runner.availableOptions(scope).map((option) => ({
      id: `${DIALOGUE_OPTION_PREFIX}${option.id}`,
      label: option.label,
      kind: option.kind,
    }));
    await ctx.bus.publish({
      type,
      guildId,
      actor: { kind: "player", id: playerId },
      subject: { kind: "npc", id: ctx.bot },
      payload: {
        dialogue: tree.id,
        node: runner.node.id,
        text: runner.node.text ?? "",
        options,
      },
    });
  }

  async function open(playerId: string, guildId: string | null, ctx: CapabilityContext): Promise<void> {
    const homeGuildId = ctx.personas.homeGuild(guildId);
    const { created } = await ensurePlayer(ctx.sql, playerId, homeGuildId, DEFAULT_STARTING_GOLD);
    if (created) ctx.logger.info({ playerId, startingGold: DEFAULT_STARTING_GOLD }, "player registered");
    const runner = new DialogueRunner(tree);
    sessions.set(playerId, runner);
    const scope = await loadGuardScope(ctx.sql, playerId);
    ctx.logger.info({ playerId, dialogue: tree.id, node: runner.node.id }, "dialogue started");
    await publishNode("dialogue.opened", playerId, runner, scope, ctx, guildId);
  }

  async function choose(
    playerId: string,
    optionId: string,
    guildId: string | null,
    correlationId: string | null,
    ctx: CapabilityContext,
  ): Promise<void> {
    const runner = sessions.get(playerId);
    if (!runner) {
      ctx.logger.warn({ playerId, optionId }, "dialogue.choose for a player with no open session");
      return;
    }
    const scope = await loadGuardScope(ctx.sql, playerId);
    let result: ReturnType<DialogueRunner["choose"]>;
    try {
      result = runner.choose(optionId, scope);
    } catch (err) {
      // Stale click or a guard the player no longer passes: ignore in-fiction.
      ctx.logger.warn({ err, playerId, optionId }, "dialogue option not available");
      return;
    }

    // Publish the option's emitted events with the PLAYER as actor and this
    // NPC as subject — trade.request lands in the trade capability (§5.5).
    for (const emit of result.emit ?? []) {
      await ctx.bus.publish({
        type: emit.type,
        guildId,
        actor: { kind: "player", id: playerId },
        subject: { kind: "npc", id: ctx.bot },
        payload: emit.payload,
        correlationId,
      });
    }

    if (result.done) {
      sessions.delete(playerId);
      await publishNode("dialogue.closed", playerId, runner, scope, ctx, guildId);
      ctx.logger.info({ playerId, dialogue: tree.id, node: runner.node.id }, "dialogue finished");
      return;
    }
    await publishNode("dialogue.node", playerId, runner, scope, ctx, guildId);
  }

  return {
    name: "dialogue.thread",
    // stall.entered opens a session; dialogue.choose advances it.
    consumes: ["dialogue.choose", "stall.entered"],
    actions: {
      /** Start a dialogue for a player; a fresh runner per player-session. */
      "dialogue.start": async (args, evt, ctx: CapabilityContext) => {
        await open(String(args.player), evt?.guildId ?? null, ctx);
      },
    },

    /** Bridge Discord option clicks into `dialogue.choose` bus events. */
    init(ctx: CapabilityContext): void {
      ctx.gateway.onComponent(async (interaction) => {
        if (!interaction.customId.startsWith(DIALOGUE_OPTION_PREFIX)) return;
        await ctx.bus.publish({
          type: "dialogue.choose",
          guildId: interaction.guildId,
          actor: { kind: "player", id: interaction.userId },
          subject: { kind: "npc", id: ctx.bot },
          payload: { option: interaction.customId.slice(DIALOGUE_OPTION_PREFIX.length) },
        });
      });
    },

    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      if (evt.type === "stall.entered" && evt.actor) {
        await open(evt.actor.id, evt.guildId, ctx);
        return;
      }
      if (evt.type === "dialogue.choose" && evt.actor) {
        // Only advance sessions owned by THIS bot's persona.
        if (notForMe(evt, ctx.bot)) return;
        const option = String((evt.payload as { option?: unknown }).option ?? "");
        if (!option) return;
        await choose(evt.actor.id, option, evt.guildId, evt.correlationId, ctx);
      }
    },
  };
}
