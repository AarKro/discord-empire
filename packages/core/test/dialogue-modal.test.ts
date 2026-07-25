/**
 * Unit tests for `kind: modal` dialogue options (§5.4 "modal inputs"). The
 * primitive's contract is that a modal option is an ORDINARY option that happens
 * to carry text: it leaves as the same `dialogue.choose` a button click does, so
 * the workflow engine's option resolution never learns modals exist.
 *
 * The security-relevant assertion here is truncation: `max_length` is only a
 * client-side hint on the TextInput, and the submitted payload is player-supplied,
 * so the capability must re-apply the cap itself. Everything downstream (an LLM
 * prompt, a guard) trusts that bound.
 */
import { describe, it, expect } from "vitest";
import { dialogueCapability, DIALOGUE_INPUT_FIELD } from "../src/capabilities/dialogue.js";
import { DIALOGUE_MODAL_PREFIX, DIALOGUE_OPTION_PREFIX } from "../src/dialogue/guards.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";
import type { ComponentHandler, ModalRequest, ModalSubmitHandler } from "../src/gateway/types.js";

interface Published {
  type: string;
  payload?: Record<string, unknown>;
  actor?: { kind: string; id: string };
}

function harness() {
  const published: Published[] = [];
  const acks: string[] = [];
  let component: ComponentHandler | undefined;
  let modalRequest: ModalRequest | undefined;
  let modalSubmit: ModalSubmitHandler | undefined;

  const ctx = {
    bot: "secret_merchant",
    bus: { publish: async (input: Published) => void published.push(input) } as unknown as CapabilityContext["bus"],
    gateway: {
      onComponent: (h: ComponentHandler) => void (component = h),
      onModalRequest: (r: ModalRequest) => void (modalRequest = r),
      onModalSubmit: (h: ModalSubmitHandler) => void (modalSubmit = h),
    } as unknown as CapabilityContext["gateway"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;

  const cap = dialogueCapability();
  cap.init!(ctx);

  /** Feed the capability a render event so it learns the option's input spec. */
  const renderFor = (npcId: string, input: unknown): void => {
    const evt = {
      dbId: "1", eventId: "e1", type: "dialogue.node", ts: "", guildId: "g1",
      actor: { kind: "player", id: "p1" },
      subject: { kind: "npc", id: npcId },
      payload: { options: [{ id: `${DIALOGUE_MODAL_PREFIX}answer`, label: "Answer", kind: "modal", input }] },
      correlationId: null,
    } as unknown as BusEvent;
    cap.handle!(evt, ctx);
  };
  const render = (input: unknown): void => renderFor("secret_merchant", input);

  const submit = async (customId: string, value: string): Promise<void> => {
    await modalSubmit!({
      customId,
      fields: { [DIALOGUE_INPUT_FIELD]: value },
      userId: "p1",
      guildId: "g1",
      channelId: "c1",
      reply: async (content: string) => void acks.push(content),
    });
  };

  return { published, acks, render, renderFor, submit, click: () => component!, request: () => modalRequest! };
}

const SPEC = { label: "Your answer", placeholder: "speak plainly", max_length: 20, paragraph: false, ack: "You whisper." };

describe("kind: modal dialogue options (§5.4)", () => {
  it("submits as an ordinary dialogue.choose carrying the typed text", async () => {
    const h = harness();
    h.render(SPEC);
    await h.submit(`${DIALOGUE_MODAL_PREFIX}answer`, "a river");

    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.type).toBe("dialogue.choose");
    // The bare option id — the engine resolves it exactly like a button's.
    expect(h.published[0]!.payload).toMatchObject({ option: "answer", input: "a river" });
    expect(h.published[0]!.actor).toEqual({ kind: "player", id: "p1" });
  });

  it("re-truncates to max_length — the client-side cap is not trusted", async () => {
    const h = harness();
    h.render(SPEC);
    await h.submit(`${DIALOGUE_MODAL_PREFIX}answer`, "x".repeat(500));

    expect(h.published[0]!.payload!.input).toBe("x".repeat(20));
  });

  it("trims whitespace before truncating", async () => {
    const h = harness();
    h.render(SPEC);
    await h.submit(`${DIALOGUE_MODAL_PREFIX}answer`, "   a river   ");

    expect(h.published[0]!.payload!.input).toBe("a river");
  });

  it("acks the submit with the authored line so Discord doesn't show a failure", async () => {
    const h = harness();
    h.render(SPEC);
    await h.submit(`${DIALOGUE_MODAL_PREFIX}answer`, "a river");

    expect(h.acks).toEqual(["You whisper."]);
  });

  it("builds the field from the remembered spec", () => {
    const h = harness();
    h.render(SPEC);
    const built = h.request().build(`${DIALOGUE_MODAL_PREFIX}answer`, "p1").toJSON();
    const field = (built.components[0]! as unknown as { components: { max_length?: number; placeholder?: string; label: string }[] }).components[0]!;

    expect(h.request().matches(`${DIALOGUE_MODAL_PREFIX}answer`)).toBe(true);
    expect(h.request().matches(`${DIALOGUE_OPTION_PREFIX}leave`)).toBe(false);
    expect(field.max_length).toBe(20);
    expect(field.placeholder).toBe("speak plainly");
  });

  it("falls back to a default spec when the option was never rendered (e.g. after a reboot)", async () => {
    const h = harness();
    await h.submit(`${DIALOGUE_MODAL_PREFIX}answer`, "y".repeat(500));

    // Still bounded, still delivered — a lost cache must not become an unbounded input.
    expect(h.published[0]!.payload!.input).toBe("y".repeat(200));
    expect(h.acks).toEqual(["Sent."]);
  });

  it("ignores modal submits belonging to other capabilities", async () => {
    const h = harness();
    await h.submit("auc:bid:123", "50");

    expect(h.published).toHaveLength(0);
    expect(h.acks).toHaveLength(0);
  });

  it("still bridges plain option buttons, with no input key", async () => {
    const h = harness();
    await h.click()({
      customId: `${DIALOGUE_OPTION_PREFIX}leave`,
      values: [], userId: "p1", guildId: "g1", channelId: "c1",
      reply: async () => {}, update: async () => {},
    });

    expect(h.published[0]!.payload).toEqual({ option: "leave" });
    expect(h.published[0]!.payload).not.toHaveProperty("input");
  });

  it("ignores render events addressed to another bot (the bus is a broadcast)", async () => {
    const h = harness();
    h.renderFor("merchant", SPEC); // same option id, different NPC
    await h.submit(`${DIALOGUE_MODAL_PREFIX}answer`, "z".repeat(500));

    // Never learned the 20-char spec, so the default bound applies.
    expect(h.published[0]!.payload!.input).toBe("z".repeat(200));
    expect(h.acks).toEqual(["Sent."]);
  });
});
