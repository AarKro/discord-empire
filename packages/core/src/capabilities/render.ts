/**
 * render — the bus→Discord surface. Capabilities publish plain-data UI events
 * (stall.rendered, dialogue.opened/node/closed, trade.completed/failed); this
 * module is the ONE consumer that turns them into Discord messages via the
 * gateway ("the visible response arrives via bus-driven renders").
 *
 * Placement: the location channel comes from the `locations` table (§8: guild +
 * channel mapping), seeded by world:init. Both durable surfaces live in
 * npcs.state so a restart resumes them: the stall's pinned message id (a restart
 * edits the embed instead of re-posting) and each player's open dialogue thread
 * id (a restart still posts to the ongoing conversation, matching the dialogue
 * workflow instance that also survives). A thread entry is dropped when its tree
 * closes, so only open conversations are held.
 */
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";
import { notForMe } from "../events.js";
import { locationChannel } from "../locations.js";
import { readNpcState, upsertNpcStateEntry, deleteNpcStateEntry } from "../npc-state.js";
import { buttonRow, stallEmbed } from "../ui-kit.js";
import type { Sql } from "@empire/db";
import { readBalance } from "@empire/db";

interface DialogueOption {
  id: string;
  label: string;
}

/** Resolve the guild's bazaar text channel from game state (seeded by world:init). */
async function bazaarChannel(sql: Sql, guildId: string): Promise<string | null> {
  return locationChannel(sql, guildId, "bazaar");
}

async function loadStallMessageId(sql: Sql, npcId: string, guildId: string): Promise<string | null> {
  const state = await readNpcState<{ stall_messages?: Record<string, string> }>(sql, npcId);
  return state.stall_messages?.[guildId] ?? null;
}

async function saveStallMessageId(sql: Sql, npcId: string, guildId: string, messageId: string): Promise<void> {
  await upsertNpcStateEntry(sql, npcId, "stall_messages", guildId, messageId);
}

// A player's open dialogue thread, persisted in npcs.state (mirroring
// stall_messages) so a mid-conversation restart can still post to it — the
// workflow instance survives a restart, and now so does its rendered thread.
// Only OPEN conversations live here: the entry is removed when the tree closes.
// Exported for the persistence round-trip integration test.
export async function loadThreadId(sql: Sql, npcId: string, playerId: string): Promise<string | null> {
  const state = await readNpcState<{ dialogue_threads?: Record<string, string> }>(sql, npcId);
  return state.dialogue_threads?.[playerId] ?? null;
}

export async function saveThreadId(sql: Sql, npcId: string, playerId: string, threadId: string): Promise<void> {
  await upsertNpcStateEntry(sql, npcId, "dialogue_threads", playerId, threadId);
}

export async function removeThreadId(sql: Sql, npcId: string, playerId: string): Promise<void> {
  await deleteNpcStateEntry(sql, npcId, "dialogue_threads", playerId);
}

export function renderCapability(): Capability {
  async function renderStall(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
    const guildId = evt.guildId;
    if (!guildId) return;
    const channelId = await bazaarChannel(ctx.sql, guildId);
    if (!channelId) {
      ctx.logger.warn({ guildId }, "no bazaar location for guild — run world:init");
      return;
    }
    const payload = evt.payload as { embed?: object; components?: object[] };
    if (!payload.embed) return;
    const existing = await loadStallMessageId(ctx.sql, ctx.bot, guildId);
    const messageId = await ctx.gateway.upsertPinnedMessage(channelId, existing, {
      embeds: [payload.embed],
      components: (payload.components ?? []) as never[],
    });
    if (messageId && messageId !== existing) {
      await saveStallMessageId(ctx.sql, ctx.bot, guildId, messageId);
    }
  }

  async function openThread(evt: BusEvent, ctx: CapabilityContext): Promise<string | null> {
    const playerId = evt.actor!.id;
    const known = await loadThreadId(ctx.sql, ctx.bot, playerId);
    if (known) return known;
    const guildId = evt.guildId;
    if (!guildId) return null;
    const channelId = await bazaarChannel(ctx.sql, guildId);
    if (!channelId) {
      ctx.logger.warn({ guildId }, "no bazaar location for guild — run world:init");
      return null;
    }
    const persona = ctx.personas.resolve(guildId);
    const threadId = await ctx.gateway.createPrivateThread(channelId, `${persona.nickname} & {user}`, playerId);
    if (threadId) await saveThreadId(ctx.sql, ctx.bot, playerId, threadId);
    return threadId;
  }

  /** Post a dialogue node (bot line + option buttons) into the player's thread. */
  async function postNode(threadId: string, evt: BusEvent, ctx: CapabilityContext): Promise<void> {
    const payload = evt.payload as { text?: string; options?: DialogueOption[] };
    const options = payload.options ?? [];
    await ctx.gateway.sendToChannel(threadId, {
      content: payload.text || "…",
      components: options.length > 0
        ? [buttonRow(options.map((option) => ({ id: option.id, label: option.label }))).toJSON() as never]
        : [],
    });
  }

  return {
    name: "render",
    consumes: ["stall.rendered", "stall.closed", "dialogue.", "trade.completed", "trade.failed"],
    actions: {},

    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      // The bus is broadcast: only the addressed bot renders its own surfaces.
      if (notForMe(evt, ctx.bot)) return;

      switch (evt.type) {
        case "stall.rendered":
          await renderStall(evt, ctx);
          return;

        case "stall.closed": {
          // Re-render as closed: swap the pinned embed for the closed state.
          if (!evt.guildId) return;
          const persona = ctx.personas.resolve(evt.guildId);
          const channelId = await bazaarChannel(ctx.sql, evt.guildId);
          if (!channelId) return;
          const existing = await loadStallMessageId(ctx.sql, ctx.bot, evt.guildId);
          const messageId = await ctx.gateway.upsertPinnedMessage(channelId, existing, {
            embeds: [stallEmbed(`${persona.nickname}'s Stall`, []).toJSON()],
            components: [],
          });
          if (messageId && messageId !== existing) {
            await saveStallMessageId(ctx.sql, ctx.bot, evt.guildId, messageId);
          }
          return;
        }

        case "dialogue.opened": {
          if (!evt.actor) return;
          const threadId = await openThread(evt, ctx);
          if (threadId) await postNode(threadId, evt, ctx);
          return;
        }

        case "dialogue.node": {
          if (!evt.actor) return;
          const threadId = await loadThreadId(ctx.sql, ctx.bot, evt.actor.id);
          if (!threadId) {
            ctx.logger.warn({ player: evt.actor.id }, "dialogue.node with no open thread");
            return;
          }
          await postNode(threadId, evt, ctx);
          return;
        }

        case "dialogue.closed": {
          if (!evt.actor) return;
          const threadId = await loadThreadId(ctx.sql, ctx.bot, evt.actor.id);
          if (!threadId) return;
          await postNode(threadId, evt, ctx);
          await removeThreadId(ctx.sql, ctx.bot, evt.actor.id);
          await ctx.gateway.archiveThread(threadId);
          return;
        }

        case "trade.completed": {
          if (!evt.actor || evt.actor.kind !== "player") return;
          const threadId = await loadThreadId(ctx.sql, ctx.bot, evt.actor.id);
          if (!threadId) return;
          const payload = evt.payload as { item?: string; qty?: number; price?: number; currency?: string };
          const currency = payload.currency ?? "gold";
          const balance = await readBalance(ctx.sql, "player", evt.actor.id, currency);
          await ctx.gateway.sendToChannel(threadId, {
            content:
              `*The coin changes hands.* You bought **${payload.qty ?? 1}× ${payload.item ?? "?"}** ` +
              `for **${payload.price ?? 0} ${currency}** — ${balance} left in your purse.`,
          });
          return;
        }

        case "trade.failed": {
          if (!evt.actor || evt.actor.kind !== "player") return;
          const threadId = await loadThreadId(ctx.sql, ctx.bot, evt.actor.id);
          if (!threadId) return;
          const payload = evt.payload as { message?: string };
          await ctx.gateway.sendToChannel(threadId, { content: `*${payload.message ?? "The deal falls through."}*` });
          return;
        }
      }
    },
  };
}
