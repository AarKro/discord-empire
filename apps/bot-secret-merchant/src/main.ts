/**
 * Secret merchant — reference traveling NPC (framework spec §9). A hooded stranger
 * that walks the continent ring: present in exactly one continent at a time,
 * leaving one guild's voice and reappearing on a neighbour (see manifests/
 * secret_merchant.yaml + workflows/secret_merchant.yaml).
 *
 * Beyond wandering it hosts the stranger's two player-facing surfaces (§5.4/§11),
 * both of which are LLM-worded and therefore both metered:
 *
 *   /approach  ONE cryptic line per appearance. All of it — gates, generation,
 *              authored fallback — lives in core's `approachStranger`.
 *   /riddle    Starts the riddle session workflow, which then runs itself. This
 *              entrypoint only refuses cheaply (absent stranger, visit already
 *              spent) so a doomed request never opens a private thread.
 *
 * The same three cost gates cover both: presence, once-per-visit, and a hard
 * hourly ceiling shared across every LLM feature (core's dialogue/budget.ts).
 */
import { runBot, rootLogger, approachStranger, npcProximity, dealtThisVisit, type CommandDef } from "@empire/core";

const commands: CommandDef[] = [
  {
    // Starts the riddle workflow (workflows/secret_merchant_riddle.yaml), which
    // runs the whole session. Presence is checked HERE as well as in riddle.deal
    // so an absent stranger is refused with a cheap ephemeral line, rather than
    // opening a private thread just to say nobody is home.
    name: "riddle",
    description: "Ask the hooded stranger for a riddle, if they are near",
    route: "",
    resolve: async (ctx, { userId, guildId }) => {
      if (!(await npcProximity(ctx.sql, ctx.bot, userId)).shared) {
        return "You search the shadows, but no stranger stirs here.";
      }
      // Cost gate: one riddle per appearance, so a single player can't spend the
      // whole realm's hourly generation budget by re-running /riddle.
      if (await dealtThisVisit(ctx.sql, userId)) {
        return "*The stranger waves you off.* One riddle a visit, traveller. I have other roads to walk.";
      }
      await ctx.bus.publish({
        type: "riddle.requested",
        guildId,
        actor: { kind: "player", id: userId },
        subject: { kind: "npc", id: ctx.bot },
        payload: {},
      });
      return "*The stranger beckons you aside.* Look for their words in a thread of your own.";
    },
  },
  {
    // A direct-answer command: the resolver runs the gates + generation and
    // replies ephemerally — a private whisper from the stranger.
    name: "approach",
    description: "Approach the hooded stranger, if they are near",
    route: "",
    resolve: async (ctx, { userId, guildId }) => {
      const persona = ctx.personas.resolve(ctx.personas.homeGuild(guildId));
      return approachStranger(
        { sql: ctx.sql, bus: ctx.bus, logger: ctx.logger, npcId: ctx.bot },
        userId,
        { nickname: persona.nickname, localeFlavor: persona.locale_flavor },
      );
    },
  },
];

runBot({ manifest: "manifests/secret_merchant.yaml", configs: { commands } }).catch((err) => {
  rootLogger.error({ err }, "secret merchant crashed");
  process.exit(1);
});
