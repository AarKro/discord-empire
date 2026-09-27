/**
 * The production policy (§2.4) — pure, so every rule is pinned here: the clock
 * keeps the fraction of a unit already underway, a full store stops filling, and
 * the "next unit" countdown reads off the advanced clock.
 */
import { describe, it, expect } from "vitest";
import { accrued, msToNextUnit } from "../src/world/production.js";

const FARM = { item: "grain", per_hour: 4, cap: 16 }; // one unit per 15 minutes
const t0 = new Date("2026-09-27T12:00:00Z");
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

describe("accrued (§2.4 production)", () => {
  it("banks whole units and keeps the fraction underway", () => {
    // 40 minutes = 2 whole units + 10 minutes toward the third.
    const out = accrued(FARM, t0, at(40));
    expect(out.amount).toBe(2);
    // The clock moves by the 30 minutes taken, not to `now` — the 10 minutes
    // already spent on unit three are not thrown away.
    expect(out.since).toEqual(at(30));
    expect(msToNextUnit(FARM, out.since, at(40))).toBe(5 * 60_000);
  });

  it("collecting often earns exactly the authored rate", () => {
    // Collect every 10 minutes for two hours: 8 units, same as one collect.
    let since = t0;
    let total = 0;
    for (let m = 10; m <= 120; m += 10) {
      const out = accrued(FARM, since, at(m));
      total += out.amount;
      since = out.since;
    }
    expect(total).toBe(8);
  });

  it("a full store stops filling: capped, and the clock jumps to now", () => {
    const out = accrued(FARM, t0, at(24 * 60)); // a day away = 96 units of time
    expect(out.amount).toBe(16);
    expect(out.since).toEqual(at(24 * 60));
  });

  it("banks nothing before the first unit, leaving the clock alone", () => {
    const out = accrued(FARM, t0, at(14));
    expect(out).toEqual({ amount: 0, since: t0 });
  });

  it("treats a clock in the future (skew) as no time elapsed", () => {
    expect(accrued(FARM, at(10), t0)).toEqual({ amount: 0, since: at(10) });
  });

  it("handles fractional rates (one unit every two hours)", () => {
    const INGOT = { item: "arcane_ingot", per_hour: 0.5, cap: 4 };
    expect(accrued(INGOT, t0, at(299)).amount).toBe(2);
  });
});
