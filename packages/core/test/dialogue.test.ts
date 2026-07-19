import { describe, it, expect } from "vitest";
import { DialogueRunner, evalGuard, type GuardScope } from "../src/dialogue.js";
import { Dialogue, parseContent } from "@empire/content-schemas";

const haggle = parseContent(
  Dialogue,
  `
id: aldric_haggle
start: greet
nodes:
  - id: greet
    text: "Care to trade?"
    options:
      - { id: browse, label: "Show me your wares", goto: offer }
  - id: offer
    text: "120 gold for the arcane forge."
    options:
      - id: buy
        label: "Buy (120g)"
        guard: { expr: "player.gold >= 120" }
        goto: done
        emit:
          - { type: trade.request, payload: { item: arcane_forge, price: 120 } }
      - id: haggle
        label: "Too steep — offer 90"
        guard: { expr: "player.reputation.merchant >= 3" }
        goto: done
  - id: done
    text: "Pleasure doing business."
    final: true
`,
  "haggle.yaml",
);

describe("evalGuard", () => {
  const scope: GuardScope = {
    gold: 100,
    reputation: { merchant: 2 },
    flags: { met_aldric: true },
    position: { district: "bazaar" },
  };

  it("evaluates numeric comparisons", () => {
    expect(evalGuard("player.gold >= 50", scope)).toBe(true);
    expect(evalGuard("player.gold >= 120", scope)).toBe(false);
    expect(evalGuard("player.reputation.merchant >= 3", scope)).toBe(false);
    expect(evalGuard("player.reputation.merchant >= 2", scope)).toBe(true);
  });

  it("evaluates equality and bare flags", () => {
    expect(evalGuard("player.position == bazaar", scope)).toBe(true);
    expect(evalGuard("player.position == tavern", scope)).toBe(false);
    expect(evalGuard("player.flags.met_aldric", scope)).toBe(true);
    expect(evalGuard("player.flags.unknown", scope)).toBe(false);
  });
});

describe("DialogueRunner", () => {
  it("walks a tree and filters options by guard", () => {
    const runner = new DialogueRunner(haggle);
    expect(runner.node.id).toBe("greet");

    const scope: GuardScope = { gold: 100, reputation: { merchant: 4 }, flags: {} };
    runner.choose("browse", scope);
    expect(runner.node.id).toBe("offer");

    // Poor player cannot buy but (high rep) can haggle.
    const opts = runner.availableOptions(scope).map((o) => o.id);
    expect(opts).toContain("haggle");
    expect(opts).not.toContain("buy");
  });

  it("emits events and marks completion at final nodes", () => {
    const runner = new DialogueRunner(haggle);
    const rich: GuardScope = { gold: 500, reputation: { merchant: 0 }, flags: {} };
    runner.choose("browse", rich);
    const res = runner.choose("buy", rich);
    expect(res.done).toBe(true);
    expect(res.emit?.[0]?.type).toBe("trade.request");
  });

  it("refuses an option whose guard fails", () => {
    const runner = new DialogueRunner(haggle);
    const poor: GuardScope = { gold: 10, reputation: { merchant: 0 }, flags: {} };
    runner.choose("browse", poor);
    expect(() => runner.choose("buy", poor)).toThrowError(/not available/);
  });
});
