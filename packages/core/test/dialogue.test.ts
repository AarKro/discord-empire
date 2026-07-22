/**
 * Guard evaluation (§5.4, §7). The tree runner is retired — dialogue is now
 * workflows, so option filtering / guarded transitions / emits are covered by the
 * workflow engine + runtime suites. Here we test the shared guard expression core.
 */
import { describe, it, expect } from "vitest";
import { evalGuard, resolveSource, interpolate, type GuardScope } from "../src/dialogue.js";

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

describe("interpolate (§7 {{context.x}} templating)", () => {
  it("substitutes into mixed strings and preserves type for whole-string templates", () => {
    const ctx = { name: "Aldric", count: 3 };
    expect(interpolate("Welcome, {{context.name}}!", null, ctx)).toBe("Welcome, Aldric!");
    expect(interpolate("{{context.count}}", null, ctx)).toBe(3); // number, not "3"
    expect(interpolate("{{context.name}}", null, ctx)).toBe("Aldric");
  });

  it("recurses into objects/arrays and leaves non-strings alone", () => {
    const ctx = { who: "p1", gold: 50 };
    expect(interpolate({ msg: "hi {{context.who}}", amount: "{{context.gold}}" }, null, ctx)).toEqual({ msg: "hi p1", amount: 50 });
    expect(interpolate(["{{context.gold}}", 7], null, ctx)).toEqual([50, 7]);
    expect(interpolate(42, null, ctx)).toBe(42);
  });

  it("can weave event fields too", () => {
    expect(interpolate("from {{event.actor.id}}", { actor: { id: "p9" } }, {})).toBe("from p9");
  });
});
