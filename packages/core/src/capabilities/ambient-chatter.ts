/**
 * ambient.chatter (framework spec §5.8) — scheduled/randomized flavor posts in
 * location chats plus reactions to world events. Throttled; pure flavor.
 */
import type { Capability, CapabilityContext } from "../capability.js";

export interface ChatterConfig {
  /** event type -> candidate lines to react with. */
  reactions: Record<string, string[]>;
  throttleMs?: number;
}

export function ambientChatterCapability(config: ChatterConfig): Capability {
  let lastAt = 0;
  const throttle = config.throttleMs ?? 30_000;
  return {
    name: "ambient.chatter",
    consumes: ["world.", "npc.arrived", "trade.completed"],
    actions: {},
    handle(evt, ctx: CapabilityContext) {
      const lines = config.reactions[evt.type];
      if (!lines || lines.length === 0) return;
      const now = Date.now();
      if (now - lastAt < throttle) return;
      lastAt = now;
      const line = lines[Math.floor(Math.random() * lines.length)]!;
      ctx.logger.debug({ trigger: evt.type, line }, "ambient chatter");
    },
  };
}
