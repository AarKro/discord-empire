/**
 * riddle (framework spec §5.4 / §11) — the Secret Merchant's riddle game as
 * workflow verbs. The session itself (the question budget, the clock, the
 * branch on right/wrong) is authored in content/workflows/secret_merchant_riddle.yaml;
 * this capability only supplies the verbs that state machine calls.
 *
 * Each verb reports its outcome by EMITTING an event the next state listens for
 * via `on:`, because a workflow action cannot redirect the machine on success —
 * `runActions` only honours a returned goto on the on_error path. So instead of
 * returning "correct", `riddle.judge` publishes `riddle.solved` / `riddle.missed`
 * and the YAML branches on those. Emits carry the player as actor so the runtime's
 * scope matching routes them back to that player's own instance.
 *
 * Generated text reaches the player through the same channel: the emitted payload
 * carries it, and the target state lifts it into the prompt with
 * `set: { hint: "event.payload.text" }` + `prompt: "{{context.hint}}"`.
 *
 * Cost accounting: every verb that made a real API call also publishes
 * `dialogue.generated`, which is what dialogue/budget.ts counts — so hints and
 * judgements draw down the same hourly ceiling as the stranger's `/approach` line.
 */
import type { BusEvent } from "../events/bus.js";
import type { Capability, CapabilityContext } from "../runtime/capability.js";
import type { MessagesClient } from "../dialogue/llm.js";
import { grantReward } from "@empire/db";
import { npcProximity } from "../world/npc-state.js";
import { readFlags, setPlayerFlag } from "../world/players.js";
import { payloadString } from "../events/helpers.js";
import { judgeAnswer, pickRiddle, solvedFlag, writeHint, type Riddle } from "../dialogue/riddle.js";

/** The riddle book a bot loads from content (manifest `content.riddles`). */
export interface RiddleBook {
  riddles: Riddle[];
}

/** Args are interpolated strings by the time they reach a handler (§7). */
function arg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return value == null ? fallback : String(value);
}

export function riddleCapability(book: RiddleBook, client?: MessagesClient): Capability {
  const find = (id: string): Riddle | undefined => book.riddles.find((r) => r.id === id);

  /** The player this action is acting for — player-scoped instances always carry one. */
  const actorOf = (evt: BusEvent | null): string | null =>
    evt?.actor?.kind === "player" ? evt.actor.id : null;

  /** Publish a riddle outcome addressed to the player, so their instance advances. */
  const emit = (ctx: CapabilityContext, player: string, guildId: string | null, type: string, payload: Record<string, unknown>) =>
    ctx.bus.publish({ type, guildId, actor: { kind: "player", id: player }, subject: { kind: "npc", id: ctx.bot }, payload });

  /** Record a real API call against the shared hourly ceiling. */
  const meter = (ctx: CapabilityContext, player: string, guildId: string | null) =>
    ctx.bus.publish({
      type: "dialogue.generated",
      guildId,
      actor: { kind: "player", id: player },
      subject: { kind: "npc", id: ctx.bot },
      payload: { npc: ctx.bot, feature: "riddle" },
    });

  return {
    name: "riddle",
    consumes: [],

    actions: {
      /**
       * Deal the player their next unsolved riddle. Gated on presence: the stranger
       * must be standing on the player's continent, the same gate `/approach` uses.
       */
      "riddle.deal": async (_args, evt, ctx) => {
        const player = actorOf(evt);
        if (!player) return;
        const guildId = evt?.guildId ?? null;

        if (!(await npcProximity(ctx.sql, ctx.bot, player)).shared) {
          await emit(ctx, player, guildId, "riddle.absent", {});
          return;
        }

        const riddle = pickRiddle(book.riddles, await readFlags(ctx.sql, player));
        if (!riddle) {
          await emit(ctx, player, guildId, "riddle.exhausted", {});
          return;
        }
        await emit(ctx, player, guildId, "riddle.dealt", { riddle: riddle.id, prompt: riddle.prompt });
      },

      /**
       * Answer one of the player's questions with a hint. `used` carries the hint
       * indices already spent (the workflow threads it through context), and the
       * emitted payload carries the updated list so the next state can store it.
       */
      "riddle.hint": async (args, evt, ctx) => {
        const player = actorOf(evt);
        const riddle = find(arg(args, "riddle"));
        if (!player || !riddle) return;
        const guildId = evt?.guildId ?? null;
        const used = arg(args, "used");

        const hint = await writeHint(riddle, {
          sql: ctx.sql,
          logger: ctx.logger,
          nickname: ctx.personas.resolve(ctx.personas.homeGuild(guildId)).nickname,
          used,
          question: arg(args, "question"),
          client,
        });
        if (hint.generated) await meter(ctx, player, guildId);

        const spent = [used, String(hint.index)].filter((s) => s.length > 0 && s !== "-1").join(",");
        await emit(ctx, player, guildId, "riddle.hinted", { text: hint.text, used: spent });
      },

      /** Judge a submitted answer; branches the workflow via riddle.solved / riddle.missed. */
      "riddle.judge": async (args, evt, ctx) => {
        const player = actorOf(evt);
        const riddle = find(arg(args, "riddle"));
        if (!player || !riddle) return;
        const guildId = evt?.guildId ?? null;

        const verdict = await judgeAnswer(riddle, arg(args, "guess"), {
          sql: ctx.sql,
          logger: ctx.logger,
          client,
        });
        if (verdict.generated) await meter(ctx, player, guildId);

        await emit(ctx, player, guildId, verdict.correct ? "riddle.solved" : "riddle.missed", { riddle: riddle.id });
      },

      /**
       * Pay out, once. The flag is set BEFORE the grant so a re-entered state can't
       * double-pay, and re-running on an already-flagged riddle is a no-op.
       */
      "riddle.reward": async (args, evt, ctx) => {
        const player = actorOf(evt);
        const riddle = find(arg(args, "riddle") || payloadString(evt, "riddle"));
        if (!player || !riddle) return;

        const flag = solvedFlag(riddle.id);
        if ((await readFlags(ctx.sql, player))[flag]) return;
        await setPlayerFlag(ctx.sql, player, flag);

        // Spread key-by-key: GrantSpec's optionals are exact, so an explicit
        // `gold: undefined` is a type error rather than an omitted field.
        const { gold, item, qty, reputation } = riddle.reward;
        await grantReward(ctx.sql, {
          player,
          npc: ctx.bot,
          reason: "riddle",
          ...(gold === undefined ? {} : { gold }),
          ...(item === undefined ? {} : { item }),
          ...(qty === undefined ? {} : { qty }),
          ...(reputation === undefined ? {} : { reputation }),
        });
        await emit(ctx, player, evt?.guildId ?? null, "riddle.rewarded", { riddle: riddle.id, ...riddle.reward });
      },
    },
  };
}
