import { describe, it, expect } from "vitest";
import { availableOptions, CHOOSE_EVENT, decide, entry, guardsPass, parseOnError, scopeMatches } from "../src/workflow/engine.js";
import { parseDuration } from "../src/workflow/duration.js";
import type { GuardScope } from "../src/dialogue.js";
import { Workflow, parseContent } from "@empire/content-schemas";

const secretMerchant = parseContent(
  Workflow,
  `
id: secret_merchant_appearance
trigger: { event: tick.hour, filter: { random_chance: 0.15 } }
scope: npc
context: { npc: secret_merchant }
initial: appear
states:
  appear:
    actions:
      - { "npc.move_to": { channel: hidden_grove_vc } }
      - { emit: { type: world.rumor, payload: { hint: "hooded figure" } } }
    timer: { after: 90m, goto: vanish }
  vanish:
    actions:
      - { "npc.move_to": { channel: nowhere_vc } }
    final: true
`,
  "secret.yaml",
);

const guarded = parseContent(
  Workflow,
  `
id: gated
initial: start
states:
  start:
    on: { player.knocked: opened }
  opened:
    guards: [{ expr: "player.gold >= 50" }]
    final: true
`,
  "gated.yaml",
);

describe("parseDuration", () => {
  it("parses units", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("10s")).toBe(10_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
  });
  it("throws on garbage", () => {
    expect(() => parseDuration("soon")).toThrow();
  });
});

describe("engine transitions", () => {
  it("entry runs the initial state and arms its timer", () => {
    const dec = entry(secretMerchant);
    expect(dec.nextState).toBe("appear");
    expect(dec.timerMs).toBe(90 * 60_000);
    expect(dec.timerGoto).toBe("vanish");
    expect(dec.final).toBe(false);
    expect(dec.actions.length).toBe(2);
  });

  it("timer fires the transition to a final state", () => {
    const dec = decide(secretMerchant, "appear", { kind: "timer" });
    expect(dec.nextState).toBe("vanish");
    expect(dec.final).toBe(true);
    expect(dec.timerMs).toBe(null);
  });

  it("event transition matches by type", () => {
    const dec = decide(guarded, "start", { kind: "event", eventType: "player.knocked" }, {
      gold: 100,
      reputation: {},
      flags: {},
    });
    expect(dec.nextState).toBe("opened");
  });

  it("guard on the target state blocks the transition", () => {
    const dec = decide(guarded, "start", { kind: "event", eventType: "player.knocked" }, {
      gold: 10,
      reputation: {},
      flags: {},
    });
    expect(dec.nextState).toBe(null);
  });

  it("returns no transition for an unmatched stimulus", () => {
    const dec = decide(secretMerchant, "appear", { kind: "event", eventType: "nope" });
    expect(dec.nextState).toBe(null);
  });

  it("guardsPass evaluates all guards", () => {
    expect(guardsPass(guarded.states.opened!, { gold: 60, reputation: {}, flags: {} })).toBe(true);
    expect(guardsPass(guarded.states.opened!, { gold: 5, reputation: {}, flags: {} })).toBe(false);
  });
});

describe("parseOnError", () => {
  it("parses policies", () => {
    expect(parseOnError(undefined)).toEqual({ kind: "abort" });
    expect(parseOnError("abort")).toEqual({ kind: "abort" });
    expect(parseOnError("retry(3)")).toEqual({ kind: "retry", n: 3 });
    expect(parseOnError("cleanup")).toEqual({ kind: "goto", state: "cleanup" });
  });
});

describe("scopeMatches (§7 instance routing)", () => {
  const fromA = { actor: { kind: "player", id: "A" }, subject: { kind: "npc", id: "merchant" } };

  it("world instances accept every event", () => {
    expect(scopeMatches("world", "world", fromA)).toBe(true);
    expect(scopeMatches("world", "world", {})).toBe(true);
  });

  it("player instances only advance on their own player's events", () => {
    expect(scopeMatches("player", "A", fromA)).toBe(true);
    expect(scopeMatches("player", "B", fromA)).toBe(false); // A's event must not move B
    expect(scopeMatches("player", "A", { actor: { kind: "npc", id: "A" } })).toBe(false);
    expect(scopeMatches("player", "A", {})).toBe(false); // unattributable
  });

  it("npc instances key on the event subject", () => {
    expect(scopeMatches("npc", "merchant", fromA)).toBe(true);
    expect(scopeMatches("npc", "builder", fromA)).toBe(false);
    expect(scopeMatches("npc", "merchant", {})).toBe(false);
  });
});

const haggle = parseContent(
  Workflow,
  `
id: haggle
scope: player
initial: offer
states:
  offer:
    prompt: "120 gold. A fair price."
    options:
      - id: buy
        label: "Buy (120g)"
        guard: { expr: "player.gold >= 120" }
        goto: sold
        emit: [{ type: trade.request, payload: { item: forge, price: 120 } }]
      - { id: walk, label: "Too steep", goto: farewell }
  sold: { prompt: "A pleasure.", final: true }
  farewell: { prompt: "Safe travels.", final: true }
`,
  "haggle.yaml",
);

const scopeWith = (gold: number): GuardScope => ({ gold, reputation: {}, flags: {} });
const choose = (option: string) => ({ kind: "event" as const, eventType: CHOOSE_EVENT, payload: { option } });

describe("option-driven transitions (§5.4 dialogue-as-workflow)", () => {
  it("takes a chosen option's goto and returns its emits", () => {
    const dec = decide(haggle, "offer", choose("buy"), scopeWith(200));
    expect(dec.nextState).toBe("sold");
    expect(dec.final).toBe(true);
    expect(dec.emits).toEqual([{ type: "trade.request", payload: { item: "forge", price: 120 } }]);
  });

  it("blocks an option whose guard fails (stale/unaffordable click)", () => {
    const dec = decide(haggle, "offer", choose("buy"), scopeWith(10));
    expect(dec.nextState).toBe(null);
  });

  it("ignores an unknown option id", () => {
    expect(decide(haggle, "offer", choose("nope"), scopeWith(200)).nextState).toBe(null);
  });

  it("an unguarded option transitions with no emits", () => {
    const dec = decide(haggle, "offer", choose("walk"), scopeWith(0));
    expect(dec.nextState).toBe("farewell");
    expect(dec.emits).toEqual([]);
  });

  it("availableOptions filters by the per-option guard", () => {
    const offer = haggle.states.offer!;
    expect(availableOptions(offer, scopeWith(200)).map((o) => o.id)).toEqual(["buy", "walk"]);
    expect(availableOptions(offer, scopeWith(10)).map((o) => o.id)).toEqual(["walk"]);
  });
});
