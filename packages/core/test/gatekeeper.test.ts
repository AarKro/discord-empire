/**
 * Unit tests for the gatekeeper's pure discovered-set maths (§9): the Observer
 * set a player should hold (home's ring-neighbours ∪ recorded discoveries, minus
 * home) and the continents newly discovered by arriving somewhere (it + its
 * neighbours). These are the accumulative-model primitives; the DB reconciliation
 * is covered by the integration suite.
 */
import { describe, it, expect } from "vitest";
import { observerContinents, discoveredByArriving } from "../src/capabilities/gatekeeper.js";
import type { Continents } from "@empire/content-schemas";

const THREE: Continents = {
  continents: {
    g1: { name: "One", order: 1, neighbors: ["g2"] },
    g2: { name: "Two", order: 2, neighbors: ["g1", "g3"] },
    g3: { name: "Three", order: 3, neighbors: ["g2"] },
  },
};

describe("gatekeeper — accumulative discovered-set maths (§9)", () => {
  it("observer set = home's ring-neighbours ∪ discovered, minus home", () => {
    // Fresh at home g1: only its neighbour g2 is watched.
    expect(observerContinents(THREE, "g1", []).sort()).toEqual(["g2"]);
    // After discovering g2 + g3, both are watched (deduped against the home neighbour).
    expect(observerContinents(THREE, "g1", ["g2", "g3"]).sort()).toEqual(["g2", "g3"]);
  });

  it("home is never in its own observer set (even if passed in as discovered)", () => {
    expect(observerContinents(THREE, "g2", ["g1", "g2", "g3"])).not.toContain("g2");
    expect(observerContinents(THREE, "g2", ["g1", "g2", "g3"]).sort()).toEqual(["g1", "g3"]);
  });

  it("discoveredByArriving = the continent plus its ring-neighbours", () => {
    expect(discoveredByArriving(THREE, "g2").sort()).toEqual(["g1", "g2", "g3"]);
    expect(discoveredByArriving(THREE, "g1").sort()).toEqual(["g1", "g2"]);
  });

  it("an unknown continent yields just itself; an unknown home has no observers", () => {
    expect(discoveredByArriving(THREE, "gX")).toEqual(["gX"]);
    expect(observerContinents(THREE, "gX", [])).toEqual([]);
  });
});
