/**
 * Unit tests for the LLM wording helper (§5.4/§11): generateLine returns the
 * model's text on success and THROWS on every failure path (refusal, empty
 * output, disabled key) so callers fall back to authored lines. The client is
 * injected — no network.
 */
import { describe, it, expect, afterEach } from "vitest";
import { generateLine, isDialogueLlmEnabled, type MessagesClient } from "../src/dialogue/llm.js";

function client(res: { stop_reason: string | null; content: { type: string; text?: string }[] }): MessagesClient {
  return { messages: { create: async () => res } };
}

const OPTS = { system: "be cryptic", user: "a traveller approaches" };

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("generateLine (§5.4/§11)", () => {
  it("returns the model's text on success", async () => {
    const line = await generateLine(OPTS, client({ stop_reason: "end_turn", content: [{ type: "text", text: "  The tide turns.  " }] }));
    expect(line).toBe("The tide turns.");
  });

  it("throws on a refusal", async () => {
    await expect(generateLine(OPTS, client({ stop_reason: "refusal", content: [] }))).rejects.toThrow(/refus/i);
  });

  it("throws when the model returns no text", async () => {
    await expect(generateLine(OPTS, client({ stop_reason: "end_turn", content: [] }))).rejects.toThrow();
  });

  it("throws when disabled (no key, no injected client)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(isDialogueLlmEnabled()).toBe(false);
    await expect(generateLine(OPTS)).rejects.toThrow(/disabled/i);
  });

  it("reports enabled when a key is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(isDialogueLlmEnabled()).toBe(true);
  });
});
