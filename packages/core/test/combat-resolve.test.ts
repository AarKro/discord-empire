/**
 * Unit tests for the combat resolver (§2.6, §5.13). The resolver is pure —
 * force + encounter + seed in, round log out — so this suite needs neither a
 * database nor Discord, and can assert the property the whole audit story rests
 * on: the same seed always replays the same fight.
 */
import { describe, it, expect } from "vitest";
import {
  resolveBattle,
  rollLoot,
  MAX_ROUNDS,
  type Encounter,
  type Force,
} from "../src/combat/resolve.js";
import {
  matchupMultiplier,
  isUnitType,
  championStats,
  BASE_STATS,
  ADVANTAGE,
  DISADVANTAGE,
  UNIT_TYPES,
  type UnitType,
} from "../src/combat/types.js";

/** A troop stack of `qty` units of `type`, at the type's base stats. */
function stack(unitType: UnitType, qty: number) {
  return { unitType, qty, ...BASE_STATS[unitType] };
}

function monster(unitType: UnitType, over: Partial<Encounter> = {}): Encounter {
  return { id: "wolves", name: "Moor Wolves", unitType, atk: 20, def: 5, hp: 200, ...over };
}

describe("matchup triangle (§2.6)", () => {
  it("gives every type exactly one prey and one predator", () => {
    for (const type of UNIT_TYPES) {
      const beaten = UNIT_TYPES.filter((other) => matchupMultiplier(type, other) === ADVANTAGE);
      const beatenBy = UNIT_TYPES.filter((other) => matchupMultiplier(type, other) === DISADVANTAGE);
      expect(beaten).toHaveLength(1);
      expect(beatenBy).toHaveLength(1);
    }
  });

  it("treats a mirror match as neutral", () => {
    for (const type of UNIT_TYPES) expect(matchupMultiplier(type, type)).toBe(1);
  });

  it("makes advantage and disadvantage exact inverses, so a mirrored pair is a wash", () => {
    expect(ADVANTAGE * DISADVANTAGE).toBeCloseTo(1, 10);
  });

  it("recognises only real unit types", () => {
    expect(isUnitType("infantry")).toBe(true);
    expect(isUnitType("siege")).toBe(false);
  });

  it("grows the champion's block with level", () => {
    const one = championStats(1);
    const three = championStats(3);
    expect(three.atk).toBeGreaterThan(one.atk);
    expect(three.hp).toBeGreaterThan(one.hp);
  });
});

describe("resolveBattle determinism (§5.13 seeded & logged)", () => {
  const force: Force = { troops: [stack("infantry", 6)], champion: null };

  it("replays byte-identically from the same seed", () => {
    const a = resolveBattle({ force, encounter: monster("cavalry"), seed: "seed-abc" });
    const b = resolveBattle({ force, encounter: monster("cavalry"), seed: "seed-abc" });
    expect(b).toEqual(a);
  });

  it("diverges on a different seed", () => {
    const a = resolveBattle({ force, encounter: monster("cavalry"), seed: "seed-abc" });
    const b = resolveBattle({ force, encounter: monster("cavalry"), seed: "seed-xyz" });
    // Same shape of fight, different rolls — the damage figures must differ.
    expect(b.rounds.map((r) => r.forceDamage)).not.toEqual(a.rounds.map((r) => r.forceDamage));
  });

  it("carries the seed into the result for the audit trail", () => {
    expect(resolveBattle({ force, encounter: monster("cavalry"), seed: "s1" }).seed).toBe("s1");
  });
});

describe("resolveBattle outcomes", () => {
  it("lets the type advantage swing an otherwise identical fight", () => {
    // Same force size, same seed, same monster stats — only the monster's type
    // differs, so any change in outcome is the triangle doing its job.
    const troops = { troops: [stack("infantry", 5)], champion: null };
    for (const seed of ["a", "b", "c", "d", "e"]) {
      // Infantry counters cavalry and is countered by archers.
      expect(resolveBattle({ force: troops, encounter: monster("cavalry"), seed }).outcome).toBe("victory");
      expect(resolveBattle({ force: troops, encounter: monster("archer"), seed }).outcome).toBe("defeat");
    }
  });

  it("wins a lopsided fight regardless of seed", () => {
    const host: Force = { troops: [stack("infantry", 40)], champion: null };
    for (const seed of ["a", "b", "c", "d", "e"]) {
      expect(resolveBattle({ force: host, encounter: monster("cavalry", { hp: 40 }), seed }).outcome).toBe("victory");
    }
  });

  it("loses a hopeless fight regardless of seed", () => {
    const scraps: Force = { troops: [stack("archer", 1)], champion: null };
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const result = resolveBattle({ force: scraps, encounter: monster("cavalry", { atk: 90, hp: 900 }), seed });
      expect(result.outcome).toBe("defeat");
    }
  });

  it("counts the champion into the force", () => {
    // Tuned so the four infantry alone cannot finish the monster inside the
    // round cap but the champion's block tips it — and asserted across seeds,
    // so this is the champion mattering rather than one lucky roll.
    const encounter = monster("cavalry", { atk: 40, hp: 360 });
    const alone: Force = { troops: [stack("infantry", 4)], champion: null };
    const escorted: Force = {
      ...alone,
      champion: { unitType: "infantry", level: 3, ...championStats(3) },
    };
    for (const seed of ["a", "b", "c", "d", "e"]) {
      expect(resolveBattle({ force: alone, encounter, seed }).outcome).toBe("defeat");
      expect(resolveBattle({ force: escorted, encounter, seed }).outcome).toBe("victory");
    }
  });
});

describe("resolveBattle guards & termination", () => {
  it("terminates at the round cap without resolving forever", () => {
    // Two heavily-armoured, low-damage sides: the fight cannot finish naturally.
    const tanks: Force = { troops: [{ unitType: "infantry", qty: 2, atk: 1, def: 400, hp: 5000 }], champion: null };
    const result = resolveBattle({
      force: tanks,
      encounter: monster("infantry", { atk: 1, def: 400, hp: 5000 }),
      seed: "stalemate",
    });
    expect(result.rounds).toHaveLength(MAX_ROUNDS);
    expect(result.forceHpRemaining).toBeGreaterThan(0);
    expect(result.encounterHpRemaining).toBeGreaterThan(0);
  });

  it("loses without a fight when nothing was sent", () => {
    const result = resolveBattle({ force: { troops: [], champion: null }, encounter: monster("cavalry"), seed: "s" });
    expect(result.outcome).toBe("defeat");
    expect(result.rounds).toEqual([]);
  });

  it("wins without a fight against a hollow encounter", () => {
    const result = resolveBattle({
      force: { troops: [stack("infantry", 1)], champion: null },
      encounter: monster("cavalry", { hp: 0 }),
      seed: "s",
    });
    expect(result.outcome).toBe("victory");
    expect(result.rounds).toEqual([]);
  });

  it("stops the log the moment a side falls", () => {
    const result = resolveBattle({
      force: { troops: [stack("archer", 30)], champion: null },
      encounter: monster("infantry", { hp: 60 }),
      seed: "quick",
    });
    expect(result.encounterHpRemaining).toBe(0);
    // No rounds are logged after the killing blow.
    expect(result.rounds.filter((r) => r.encounterHp === 0)).toHaveLength(1);
    expect(result.rounds.at(-1)!.encounterHp).toBe(0);
  });

  it("logs monotonically decreasing hp and a line per round", () => {
    const result = resolveBattle({
      force: { troops: [stack("infantry", 5)], champion: null },
      encounter: monster("cavalry"),
      seed: "log-shape",
    });
    result.rounds.forEach((round, i) => {
      expect(round.round).toBe(i + 1);
      expect(round.line).toContain(`Round ${i + 1}`);
      expect(round.forceDamage).toBeGreaterThan(0);
      if (i > 0) {
        expect(round.forceHp).toBeLessThanOrEqual(result.rounds[i - 1]!.forceHp);
        expect(round.encounterHp).toBeLessThanOrEqual(result.rounds[i - 1]!.encounterHp);
      }
    });
  });
});

describe("rollLoot", () => {
  const table = [
    { item: "wolf_pelt", qty: 2, chance: 1 },
    { item: "iron_ore", qty: 1, chance: 0 },
  ];

  it("is deterministic in the battle seed", () => {
    expect(rollLoot(table, "seed-1")).toEqual(rollLoot(table, "seed-1"));
  });

  it("always drops a certainty and never drops an impossibility", () => {
    const won = rollLoot(table, "seed-1");
    expect(won).toEqual([{ item: "wolf_pelt", qty: 2 }]);
  });

  it("keeps a zero-quantity entry out of the haul", () => {
    expect(rollLoot([{ item: "nothing", qty: 0, chance: 1 }], "s")).toEqual([]);
  });

  it("draws a stream independent of the combat rounds", () => {
    // A coin-flip entry must not be perfectly correlated with the fight's rolls;
    // across many seeds it should land on both sides.
    const coin = [{ item: "trinket", qty: 1, chance: 0.5 }];
    const outcomes = new Set(
      Array.from({ length: 40 }, (_, i) => rollLoot(coin, `seed-${i}`).length > 0),
    );
    expect(outcomes).toEqual(new Set([true, false]));
  });
});
