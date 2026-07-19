import { describe, it, expect } from "vitest";
import { Shop, Manifest, Workflow, parseContent, ContentValidationError } from "../src/index.js";

describe("content validation", () => {
  it("accepts a valid shop", () => {
    const shop = parseContent(
      Shop,
      `
id: aldric
items:
  - { item_id: bread, name: Bread, base_price: 5, stock: 100 }
`,
      "shop.yaml",
    );
    expect(shop.currency).toBe("gold");
    expect(shop.items[0]!.item_id).toBe("bread");
  });

  it("rejects a shop with no items and reports a readable path", () => {
    expect(() => parseContent(Shop, `id: broken\nitems: []`, "broken.yaml")).toThrowError(
      ContentValidationError,
    );
    try {
      parseContent(Shop, `id: broken\nitems: []`, "broken.yaml");
    } catch (e) {
      expect((e as Error).message).toContain("items");
    }
  });

  it("validates a manifest with per-guild personas", () => {
    const m = parseContent(
      Manifest,
      `
id: merchant
token_env: MERCHANT_TOKEN
capabilities: [presence.voice, stall, trade]
personas:
  guild_111:
    nickname: Aldric the Trader
`,
      "manifest.yaml",
    );
    expect(m.personas["guild_111"]!.nickname).toBe("Aldric the Trader");
  });

  it("validates a workflow with a timer transition and rejects a bad duration", () => {
    const wf = parseContent(
      Workflow,
      `
id: appear
initial: appear
states:
  appear:
    timer: { after: 90m, goto: vanish }
  vanish:
    final: true
`,
      "wf.yaml",
    );
    expect(wf.states["appear"]!.timer!.after).toBe("90m");

    expect(() =>
      parseContent(
        Workflow,
        `id: bad\ninitial: a\nstates:\n  a:\n    timer: { after: soon, goto: b }\n  b: { final: true }`,
        "bad.yaml",
      ),
    ).toThrowError(ContentValidationError);
  });
});
