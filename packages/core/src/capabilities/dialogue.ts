/**
 * dialogue (framework spec §5.4) — the lean bridge between Discord and the
 * workflow engine's player prompts. Dialogue trees are now WORKFLOWS
 * (content/workflows/*_haggle.yaml): the runtime renders each prompt-bearing
 * state as thread messages and drives transitions. This capability turns a
 * player's answer to a prompt into the `dialogue.choose` event the runtime's
 * current state listens for — the reverse of the runtime's option rendering.
 *
 * Two option shapes arrive here, and both leave as the SAME event:
 *   button (`dlg:`)  — the click is the whole answer.
 *   modal  (`dlgm:`) — the click opens a text field (§5.4 "modal inputs") and
 *                      the typed value rides along as `payload.input`, which a
 *                      state captures with `set: { x: "event.payload.input" }`.
 * Keeping modals on `dialogue.choose` leaves the engine's option resolution
 * untouched: a modal option is an ordinary option that happens to carry text.
 */
import type { BusEvent } from "../events/bus.js";
import type { Capability, CapabilityContext } from "../runtime/capability.js";
import { notForMe } from "../events/helpers.js";
import { DIALOGUE_OPTION_PREFIX, DIALOGUE_MODAL_PREFIX } from "../dialogue/guards.js";
import { modal } from "../ui/kit.js";

/** The single TextInput a modal option opens; its value becomes `payload.input`. */
export const DIALOGUE_INPUT_FIELD = "input";

/** Structural mirror of content-schemas' DialogueInput (it arrives as event payload). */
interface InputSpec {
  label: string;
  placeholder?: string;
  max_length: number;
  paragraph: boolean;
  ack: string;
}

const FALLBACK_INPUT: InputSpec = { label: "Your reply", max_length: 200, paragraph: false, ack: "Sent." };

export function dialogueCapability(): Capability {
  // Input specs, keyed by the option's custom id, learned from the render events
  // this bot publishes: the modal builder is handed only a custom id, so the spec
  // has to be remembered at render time. Content is static, so this stays small.
  const specs = new Map<string, InputSpec>();

  return {
    name: "dialogue",
    consumes: ["dialogue.opened", "dialogue.node"],
    actions: {},

    /** Remember the input spec of every modal option this bot renders. */
    handle(evt: BusEvent, ctx: CapabilityContext): void {
      if (notForMe(evt, ctx.bot)) return;
      const options = (evt.payload as { options?: { id: string; input?: InputSpec }[] } | null)?.options ?? [];
      for (const option of options) {
        if (option.input && option.id.startsWith(DIALOGUE_MODAL_PREFIX)) specs.set(option.id, option.input);
      }
    },

    init(ctx: CapabilityContext): void {
      /** One `dialogue.choose`, whether the answer came from a button or a modal. */
      const choose = (customId: string, prefix: string, userId: string, guildId: string | null, input?: string) =>
        ctx.bus.publish({
          type: "dialogue.choose",
          guildId,
          actor: { kind: "player", id: userId },
          subject: { kind: "npc", id: ctx.bot },
          payload: { option: customId.slice(prefix.length), ...(input === undefined ? {} : { input }) },
        });

      // Plain option buttons — the click IS the answer.
      ctx.gateway.onComponent(async (interaction) => {
        if (!interaction.customId.startsWith(DIALOGUE_OPTION_PREFIX)) return;
        await choose(interaction.customId, DIALOGUE_OPTION_PREFIX, interaction.userId, interaction.guildId);
      });

      // Modal options — intercepted before the gateway's auto-ack so showModal is legal.
      ctx.gateway.onModalRequest({
        matches: (id) => id.startsWith(DIALOGUE_MODAL_PREFIX),
        build: (id) => {
          const spec = specs.get(id) ?? FALLBACK_INPUT;
          return modal(id, spec.label.slice(0, 45), [
            {
              id: DIALOGUE_INPUT_FIELD,
              label: spec.label,
              placeholder: spec.placeholder,
              maxLength: spec.max_length,
              paragraph: spec.paragraph,
            },
          ]);
        },
      });

      ctx.gateway.onModalSubmit(async (submitted) => {
        if (!submitted.customId.startsWith(DIALOGUE_MODAL_PREFIX)) return;
        const spec = specs.get(submitted.customId) ?? FALLBACK_INPUT;
        // Re-truncate: max_length is a client-side hint on a player-supplied payload
        // and is not trusted here — this is the cap that actually bounds the prompt.
        const input = (submitted.fields[DIALOGUE_INPUT_FIELD] ?? "").trim().slice(0, spec.max_length);
        await choose(submitted.customId, DIALOGUE_MODAL_PREFIX, submitted.userId, submitted.guildId, input);
        await submitted.reply(spec.ack);
      });
    },
  };
}
