import { describe, expect, it } from "vitest";
import { Backoff } from "../src/backoff.js";

describe("Backoff", () => {
  it("fires immediately the first time a key is seen", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 8000 });
    expect(b.due("a", 0)).toBe(true);
    expect(b.attempts("a")).toBe(1);
  });

  it("suppresses a retry until the delay has elapsed", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 8000 });
    b.due("a", 0);
    expect(b.due("a", 999)).toBe(false);
    expect(b.due("a", 1000)).toBe(true);
  });

  it("doubles the delay on each attempt, up to the ceiling", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 4000 });
    let now = 0;
    b.due("a", now); // attempt 1, next at +1000
    const gaps: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      let waited = 0;
      while (!b.due("a", now)) {
        now += 100;
        waited += 100;
      }
      gaps.push(waited);
    }
    // 1000 → 2000 → 4000 → capped at 4000 → 4000
    expect(gaps).toEqual([1000, 2000, 4000, 4000, 4000]);
  });

  it("tracks keys independently", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 8000 });
    expect(b.due("a", 0)).toBe(true);
    expect(b.due("b", 0)).toBe(true);
    expect(b.due("a", 500)).toBe(false);
    expect(b.due("b", 1000)).toBe(true);
  });

  it("forgets keys that are no longer live, so a recurrence retries at once", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 8000 });
    b.due("a", 0);
    b.due("b", 0);
    expect(b.size).toBe(2);

    b.retain(["b"]); // "a" completed
    expect(b.size).toBe(1);
    expect(b.attempts("a")).toBe(0);

    // A fresh sighting of "a" fires immediately rather than inheriting the delay.
    expect(b.due("a", 10)).toBe(true);
  });

  it("keeps live keys across a retain sweep", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 8000 });
    b.due("a", 0);
    b.retain(["a"]);
    expect(b.attempts("a")).toBe(1);
    expect(b.due("a", 10)).toBe(false);
  });
});
