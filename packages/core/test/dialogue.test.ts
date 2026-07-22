/**
 * Guard evaluation (§5.4, §7). The tree runner is retired — dialogue is now
 * workflows, so option filtering / guarded transitions / emits are covered by the
 * workflow engine + runtime suites. Here we test the shared guard expression core.
 */
import { describe, it, expect } from "vitest";
import { evalGuard, type GuardScope } from "../src/dialogue.js";

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
