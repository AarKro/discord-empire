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

  it("rejects a shop item that is both unlimited and rate-restocked", () => {
    // Accepting both and silently ignoring one is a content trap: the author
    // would think they had tuned a rate that never runs.
    expect(() =>
      parseContent(
        Shop,
        `id: s\nitems:\n  - { item_id: bread, name: Bread, base_price: 5, stock: 100, unlimited: true, restock: 10 }`,
        "shop.yaml",
      ),
    ).toThrowError(ContentValidationError);
  });

  it("accepts each of unlimited and restock on their own", () => {
    const shop = parseContent(
      Shop,
      `
id: s
items:
  - { item_id: bread, name: Bread, base_price: 5, stock: 100, unlimited: true }
  - { item_id: ore, name: Ore, base_price: 25, stock: 40, restock: 10 }
`,
      "shop.yaml",
    );
    expect(shop.items[0]!.unlimited).toBe(true);
    expect(shop.items[1]!.restock).toBe(10);
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
