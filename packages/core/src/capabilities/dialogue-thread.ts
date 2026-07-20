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
import type { Sql } from "@empire/db";
import { ensurePlayer } from "@empire/db";
import { DialogueRunner, type GuardScope } from "../dialogue.js";

/**
 * First interaction = registration (§2.1): the player row + starting-gold
 * grant are created the moment someone first enters a conversation. Default
 * must clear the shipped haggle tree's `player.gold >= 120` guard.
 */
const STARTING_GOLD = Number(process.env.STARTING_GOLD ?? 150);

/** Custom-id prefix for dialogue option buttons rendered by the bot. */
export const DIALOGUE_OPTION_PREFIX = "dlg:";

/** Load the player's guard scope (§7 guards) from game state. Reads only. */
export async function loadGuardScope(sql: Sql, playerId: string): Promise<GuardScope> {
  const [bal] = await sql<{ amount: number }[]>`
    SELECT amount FROM balances
    WHERE owner_kind = 'player' AND owner_id = ${playerId} AND currency = 'gold'
  `;
  const reps = await sql<{ npc_id: string; score: number }[]>`
    SELECT npc_id, score FROM reputation WHERE player_id = ${playerId}
  `;
  const [player] = await sql<{ flags: Record<string, boolean>; position_district_id: string | null }[]>`
    SELECT flags, position_district_id FROM players WHERE discord_user_id = ${playerId}
  `;
  return {
    gold: Number(bal?.amount ?? 0),
    reputation: Object.fromEntries(reps.map((r) => [r.npc_id, r.score])),
    flags: player?.flags ?? {},
    position: { district: player?.position_district_id ?? null },
  };
}

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
    const options = runner.availableOptions(scope).map((o) => ({
      id: `${DIALOGUE_OPTION_PREFIX}${o.id}`,
      label: o.label,
      kind: o.kind,
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
    const { created } = await ensurePlayer(ctx.sql, playerId, homeGuildId, STARTING_GOLD);
    if (created) ctx.logger.info({ playerId, startingGold: STARTING_GOLD }, "player registered");
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
      ctx.gateway.onComponent(async (i) => {
        if (!i.customId.startsWith(DIALOGUE_OPTION_PREFIX)) return;
        await ctx.bus.publish({
          type: "dialogue.choose",
          guildId: i.guildId,
          actor: { kind: "player", id: i.userId },
          subject: { kind: "npc", id: ctx.bot },
          payload: { option: i.customId.slice(DIALOGUE_OPTION_PREFIX.length) },
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
