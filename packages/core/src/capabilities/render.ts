/**
 * render — the bus→Discord surface. Capabilities publish plain-data UI events
 * (stall.rendered, dialogue.opened/node/closed, trade.completed/failed); this
 * module is the ONE consumer that turns them into Discord messages via the
 * gateway ("the visible response arrives via bus-driven renders").
 *
 * Placement: the location channel comes from the `locations` table (§8: guild +
 * channel mapping), seeded by world:init. The stall's pinned message id is
 * persisted in npcs.state so a restart edits the embed instead of re-posting;
 * per-player dialogue threads are in-memory, matching the dialogue capability's
 * in-memory sessions (open conversations do not survive restarts in iteration 1).
 */
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";
import { notForMe } from "../events.js";
import { buttonRow, stallEmbed } from "../ui-kit.js";
import type { Sql } from "@empire/db";
import { jsonParam } from "@empire/db";

interface DialogueOption {
  id: string;
  label: string;
}

/** Resolve the guild's bazaar text channel from game state (seeded by world:init). */
async function bazaarChannel(sql: Sql, guildId: string): Promise<string | null> {
  const [loc] = await sql<{ channel_id: string | null }[]>`
    SELECT channel_id FROM locations WHERE guild_id = ${guildId} AND kind = 'bazaar' LIMIT 1
  `;
  return loc?.channel_id ?? null;
}

async function loadStallMessageId(sql: Sql, npcId: string, guildId: string): Promise<string | null> {
  const [npc] = await sql<{ state: { stall_messages?: Record<string, string> } }[]>`
    SELECT state FROM npcs WHERE id = ${npcId}
  `;
  return npc?.state.stall_messages?.[guildId] ?? null;
}

async function saveStallMessageId(sql: Sql, npcId: string, guildId: string, messageId: string): Promise<void> {
  await sql`
    UPDATE npcs
       SET state = jsonb_set(
         jsonb_set(state, '{stall_messages}', COALESCE(state->'stall_messages', '{}'::jsonb)),
         ARRAY['stall_messages', ${guildId}],
         ${jsonParam(sql, messageId)}
       )
     WHERE id = ${npcId}
  `;
}

export function renderCapability(): Capability {
  /** playerId → open conversation thread. */
  const threads = new Map<string, string>();

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
    const known = threads.get(playerId);
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
    if (threadId) threads.set(playerId, threadId);
    return threadId;
  }

  /** Post a dialogue node (bot line + option buttons) into the player's thread. */
  async function postNode(threadId: string, evt: BusEvent, ctx: CapabilityContext): Promise<void> {
    const payload = evt.payload as { text?: string; options?: DialogueOption[] };
    const options = payload.options ?? [];
    await ctx.gateway.sendToChannel(threadId, {
      content: payload.text || "…",
      components: options.length > 0
        ? [buttonRow(options.map((o) => ({ id: o.id, label: o.label }))).toJSON() as never]
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
          const threadId = threads.get(evt.actor.id);
          if (!threadId) {
            ctx.logger.warn({ player: evt.actor.id }, "dialogue.node with no open thread (restart?)");
            return;
          }
          await postNode(threadId, evt, ctx);
          return;
        }

        case "dialogue.closed": {
          if (!evt.actor) return;
          const threadId = threads.get(evt.actor.id);
          if (!threadId) return;
          await postNode(threadId, evt, ctx);
          threads.delete(evt.actor.id);
          await ctx.gateway.archiveThread(threadId);
          return;
        }

        case "trade.completed": {
          if (!evt.actor || evt.actor.kind !== "player") return;
          const threadId = threads.get(evt.actor.id);
          if (!threadId) return;
          const p = evt.payload as { item?: string; qty?: number; price?: number; currency?: string };
          const [bal] = await ctx.sql<{ amount: number }[]>`
            SELECT amount FROM balances
            WHERE owner_kind = 'player' AND owner_id = ${evt.actor.id} AND currency = ${p.currency ?? "gold"}
          `;
          await ctx.gateway.sendToChannel(threadId, {
            content:
              `*The coin changes hands.* You bought **${p.qty ?? 1}× ${p.item ?? "?"}** ` +
              `for **${p.price ?? 0} ${p.currency ?? "gold"}** — ${bal?.amount ?? 0} left in your purse.`,
          });
          return;
        }

        case "trade.failed": {
          if (!evt.actor || evt.actor.kind !== "player") return;
          const threadId = threads.get(evt.actor.id);
          if (!threadId) return;
          const p = evt.payload as { message?: string };
          await ctx.gateway.sendToChannel(threadId, { content: `*${p.message ?? "The deal falls through."}*` });
          return;
        }
      }
    },
  };
}
