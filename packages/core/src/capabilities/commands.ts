/**
 * commands (framework spec §5.10) — declarative slash command surface routed to
 * workflows/capabilities, with autocomplete backed by game data. Registration is
 * idempotent per guild (§9). Command definitions are declared by each bot; this
 * capability owns routing + registration bookkeeping.
 */
import type { Capability, CapabilityContext } from "../capability.js";

export interface CommandDef {
  name: string;
  description: string;
  /** Workflow id or action verb the command routes to. */
  route: string;
  options?: { name: string; description: string; autocomplete?: boolean; required?: boolean }[];
}

export function commandsCapability(defs: CommandDef[]): Capability {
  return {
    name: "commands",
    consumes: [],
    actions: {
      "commands.list": (_args, _evt, ctx: CapabilityContext) => {
        ctx.logger.info({ commands: defs.map((d) => d.name) }, "command definitions");
      },
    },
    init(ctx) {
      // Actual registerApplicationCommands runs in the bot process against the
      // gateway; here we record intent for observability.
      ctx.logger.info({ count: defs.length }, "commands capability initialised");
    },
  };
}
