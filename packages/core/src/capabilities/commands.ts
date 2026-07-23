/**
 * commands (framework spec §5.10) — declarative slash command surface routed to
 * workflows/capabilities, with autocomplete backed by game data. Registration is
 * idempotent per guild (§9). Command definitions are declared by each bot; this
 * capability owns registration, routing, and ephemeral-reply resolution.
 *
 * Two command shapes:
 *   - ROUND-TRIP commands (e.g. /build): the invocation publishes a bus event
 *     whose type is the CommandDef.route (e.g. "build.requested"), carrying a
 *     correlationId. The deferred reply callback is held in-capability keyed by
 *     that correlationId; a later RESULT event (build.queued / build.rejected /
 *     command.reply) with the same correlationId resolves the ephemeral reply.
 *     A timeout guarantees the interaction never hangs.
 *   - DIRECT commands (e.g. /balance, /inventory): a `resolve` function answers
 *     straight from the DB inside core — no bus round-trip.
 *
 * Discord interactions are reduced to plain data before they reach here
 * (invariant #4); this capability only ever sees plain data + a reply callback.
 */
import { ulid } from "ulid";
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";
import { notForMe, payloadString } from "../events.js";
import type { CommandInteraction, CommandReply } from "../gateway.js";

/** How long we wait for a result event before an in-fiction fallback reply. */
const REPLY_TIMEOUT_MS = 10_000;

/** Result event types that can resolve a held ephemeral reply by correlationId.
 *  `command.reply` is the generic channel any round-trip command can settle with
 *  (e.g. /travel); the build.* ones double as domain events other caps consume. */
const RESULT_EVENT_TYPES = ["build.queued", "build.rejected", "command.reply"];

export interface CommandDef {
  name: string;
  description: string;
  /** Workflow id or bus-event route the command publishes (round-trip only). */
  route: string;
  options?: { name: string; description: string; autocomplete?: boolean; required?: boolean }[];
  /**
   * DB-backed autocomplete resolver, run inside core. Receives what the player
   * has typed; returns up to 25 {name,value} choices. Present iff an option has
   * `autocomplete: true`.
   */
  autocomplete?: (ctx: CapabilityContext, typed: string, userId: string) => Promise<{ name: string; value: string }[]>;
  /**
   * DIRECT-answer resolver: when present, the command is answered immediately
   * from this function's return value instead of the bus round-trip. Return a
   * string for a plain reply, or a `CommandReply` to answer with an embed.
   */
  resolve?: (
    ctx: CapabilityContext,
    input: { options: Record<string, string>; userId: string; guildId: string | null },
  ) => Promise<string | CommandReply>;
}

interface Pending {
  reply: (content: string) => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

export function commandsCapability(defs: CommandDef[]): Capability {
  const byName = new Map(defs.map((def) => [def.name, def]));
  /** correlationId → the ephemeral reply awaiting a result event. */
  const pending = new Map<string, Pending>();

  function settle(correlationId: string, content: string, ctx: CapabilityContext): void {
    const held = pending.get(correlationId);
    if (!held) return;
    pending.delete(correlationId);
    clearTimeout(held.timer);
    void held.reply(content).catch((err) => ctx.logger.warn({ err }, "reply failed"));
  }

  async function onCommand(interaction: CommandInteraction, ctx: CapabilityContext): Promise<void> {
    const def = byName.get(interaction.commandName);
    if (!def) return; // another bot's command on the shared gateway — ignore.

    // Direct commands answer straight from the DB, no round-trip. Unlike the
    // round-trip path there's no result-event timeout to fall back on, so a
    // throwing resolver must reply here or the ephemeral interaction hangs.
    if (def.resolve) {
      try {
        const result = await def.resolve(ctx, { options: interaction.options, userId: interaction.userId, guildId: interaction.guildId });
        await interaction.reply(result);
      } catch (err) {
        ctx.logger.error({ err, command: interaction.commandName }, "direct command resolve failed");
        await interaction.reply("…the ledger is smudged just now. Try again in a moment.");
      }
      return;
    }

    // Round-trip commands: hold the reply keyed by a correlationId and publish
    // the route event; a later result event resolves it.
    const correlationId = `cmd_${ulid()}`;
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      void interaction.reply("…the foreman scratches his head. Try again in a moment.");
    }, REPLY_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pending.set(correlationId, { reply: interaction.reply, timer });

    ctx.logger.info({ command: interaction.commandName, route: def.route, correlationId }, "slash command routed");
    await ctx.bus.publish({
      type: def.route,
      guildId: interaction.guildId,
      actor: { kind: "player", id: interaction.userId },
      subject: { kind: "npc", id: ctx.bot },
      payload: { ...interaction.options },
      correlationId,
    });
  }

  return {
    name: "commands",
    consumes: RESULT_EVENT_TYPES,
    actions: {
      "commands.list": (_args, _evt, ctx: CapabilityContext) => {
        ctx.logger.info({ commands: defs.map((def) => def.name) }, "command definitions");
      },
    },

    async init(ctx: CapabilityContext): Promise<void> {
      // Register commands idempotently for every persona guild (§9).
      for (const guildId of ctx.personas.guildIds) {
        await ctx.gateway.registerApplicationCommands(
          guildId,
          defs.map((def) => ({ name: def.name, description: def.description, ...(def.options ? { options: def.options } : {}) })),
        );
      }

      // Wire slash-command dispatch.
      ctx.gateway.onCommand(async (interaction) => {
        await onCommand(interaction, ctx);
      });

      // Wire per-command autocomplete to the CommandDef resolver.
      ctx.gateway.onAutocomplete(async (interaction) => {
        const def = byName.get(interaction.commandName);
        if (!def?.autocomplete) return [];
        return def.autocomplete(ctx, interaction.value, interaction.userId);
      });

      ctx.logger.info({ count: defs.length }, "commands capability initialised");
    },

    /** Resolve a held ephemeral reply when its result event arrives. */
    handle(evt: BusEvent, ctx: CapabilityContext): void {
      if (!RESULT_EVENT_TYPES.includes(evt.type)) return;
      // The bus is broadcast: only resolve replies this bot is holding.
      if (notForMe(evt, ctx.bot)) return;
      if (!evt.correlationId) return;
      const message = payloadString(evt, "message", "Done.");
      settle(evt.correlationId, message, ctx);
    },
  };
}
