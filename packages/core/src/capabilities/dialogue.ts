/**
 * dialogue (framework spec §5.4) — the lean bridge between Discord and the
 * workflow engine's player prompts. Dialogue trees are now WORKFLOWS
 * (content/workflows/*_haggle.yaml): the runtime renders each prompt-bearing
 * state as thread messages and drives transitions. All this capability does is
 * turn an option-button click into the `dialogue.choose` event the runtime's
 * current state listens for — the reverse of the runtime's option rendering.
 */
import type { Capability, CapabilityContext } from "../capability.js";
import { DIALOGUE_OPTION_PREFIX } from "../dialogue.js";

export function dialogueCapability(): Capability {
  return {
    name: "dialogue",
    consumes: [],
    actions: {},

    /** Bridge Discord option-button clicks into `dialogue.choose` bus events. */
    init(ctx: CapabilityContext): void {
      ctx.gateway.onComponent(async (interaction) => {
        if (!interaction.customId.startsWith(DIALOGUE_OPTION_PREFIX)) return;
        await ctx.bus.publish({
          type: "dialogue.choose",
          guildId: interaction.guildId,
          actor: { kind: "player", id: interaction.userId },
          subject: { kind: "npc", id: ctx.bot },
          payload: { option: interaction.customId.slice(DIALOGUE_OPTION_PREFIX.length) },
        });
      });
    },
  };
}
