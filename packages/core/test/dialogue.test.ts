/**
 * Guard evaluation (§5.4, §7). The tree runner is retired — dialogue is now
 * workflows, so option filtering / guarded transitions / emits are covered by the
 * workflow engine + runtime suites. Here we test the shared guard expression core.
 */
import { describe, it, expect } from "vitest";
import { evalGuard, resolveSource, type GuardScope } from "../src/dialogue.js";

describe("evalGuard", () => {
  const scope: GuardScope = {
    gold: 100,
    reputation: { merchant: 2 },
    flags: { met_aldric: true },
    position: { district: "bazaar" },
    context: { step: 3, choice: "red" },
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

  it("branches on per-instance context (§7 quest memory)", () => {
    expect(evalGuard("context.step >= 2", scope)).toBe(true);
    expect(evalGuard("context.step >= 5", scope)).toBe(false);
    expect(evalGuard("context.choice == red", scope)).toBe(true);
    expect(evalGuard("context.choice == blue", scope)).toBe(false);
    expect(evalGuard("context.missing", scope)).toBe(false);
  });
});

describe("resolveSource (§7 set: value expressions)", () => {
  const evt = {
    payload: { door: "red", nested: { n: 7 } },
    actor: { id: "p1" },
    subject: { id: "merchant" },
    correlationId: "cmd_1",
    guildId: "g1",
  };

  it("reads event fields", () => {
    expect(resolveSource("event.payload.door", evt, {})).toBe("red");
    expect(resolveSource("event.payload.nested.n", evt, {})).toBe(7);
    expect(resolveSource("event.actor.id", evt, {})).toBe("p1");
    expect(resolveSource("event.subject.id", evt, {})).toBe("merchant");
    expect(resolveSource("event.correlationId", evt, {})).toBe("cmd_1");
    expect(resolveSource("event.guildId", evt, {})).toBe("g1");
  });

  it("reads prior context and literals", () => {
    expect(resolveSource("context.step", evt, { step: 2 })).toBe(2);
    expect(resolveSource("'a literal'", evt, {})).toBe("a literal");
    expect(resolveSource("42", evt, {})).toBe(42);
    expect(resolveSource("bareword", evt, {})).toBe("bareword");
  });

  it("returns null/undefined for absent sources", () => {
    expect(resolveSource("event.correlationId", { actor: { id: "x" } }, {})).toBe(null);
    expect(resolveSource("event.payload.nope", evt, {})).toBe(undefined);
  });
});
