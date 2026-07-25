/**
 * Secret merchant — reference traveling NPC (framework spec §9). A hooded stranger
 * that walks the continent ring: present in exactly one continent at a time,
 * leaving one guild's voice and reappearing on a neighbour (see manifests/
 * secret_merchant.yaml + workflows/secret_merchant.yaml).
 *
 * Beyond wandering, it hosts `/approach` (§5.4/§11): a player on the stranger's
 * continent gets ONE cryptic, LLM-worded line per appearance. The gating +
 * generation + authored fallback all live in @empire/core's `approachStranger`
 * (three cost gates: presence, once-per-visit, a hard hourly ceiling), so this
 * entrypoint just wires the command to it.
 */
import { runBot, rootLogger, approachStranger, npcProximity, type CommandDef } from "@empire/core";

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
