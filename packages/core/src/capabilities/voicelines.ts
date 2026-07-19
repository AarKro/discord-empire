/**
 * voicelines (framework spec §5.7) — prerecorded Opus playback on event triggers
 * (npc.arrived, stall.entered, trade.completed) with cooldowns and per-persona
 * line sets. The trigger mapping is content, not code. Audio playback is a dev-
 * server concern; the trigger/cooldown bookkeeping is the testable core.
 */
import type { Capability, CapabilityContext } from "../capability.js";

export interface VoicelineConfig {
  /** trigger event type -> relative audio paths (per-persona sets keyed later). */
  triggers: Record<string, string[]>;
  cooldownMs?: number;
}

export function voicelinesCapability(config: VoicelineConfig): Capability {
  const lastPlayed = new Map<string, number>();
  const cooldown = config.cooldownMs ?? 15_000;
  return {
    name: "voicelines",
    consumes: Object.keys(config.triggers),
    actions: {},
    handle(evt, ctx: CapabilityContext) {
      const lines = config.triggers[evt.type];
      if (!lines || lines.length === 0) return;
      const now = Date.now();
      const key = `${evt.type}:${evt.guildId ?? ""}`;
      if (now - (lastPlayed.get(key) ?? 0) < cooldown) return;
      lastPlayed.set(key, now);
      const line = lines[Math.floor(Math.random() * lines.length)]!;
      ctx.logger.debug({ trigger: evt.type, line }, "voiceline played");
    },
  };
}
