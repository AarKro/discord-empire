/**
 * Unit tests for the realm leaderboard (§9): renown scoring, cross-continent
 * ranking (score-descending, top-N), and the /leaderboard embed render. The
 * per-player aggregate query is faked — we assert the scoring + ordering + render.
 */
import { describe, it, expect } from "vitest";
import { renownScore, leaderboardRows, buildLeaderboardEmbed, BUILD_WEIGHT, RESEARCH_WEIGHT } from "../src/ui/leaderboard.js";
import type { Sql } from "@empire/db";

type Row = { player: string; gold: number; builds: number; research: number };

/** A fake `sql` that answers the leaderboard aggregate with the given rows. */
function fakeSql(rows: Row[]): Sql {
  const fn = (): Promise<Row[]> => Promise.resolve(rows);
  return fn as unknown as Sql;
}

describe("renownScore (§9 placeholder weights)", () => {
  it("weights gold + builds + research", () => {
    expect(renownScore({ gold: 100, builds: 2, research: 1 })).toBe(100 + 2 * BUILD_WEIGHT + 1 * RESEARCH_WEIGHT);
  });
});

describe("leaderboardRows (§9)", () => {
  it("ranks players by renown, score-descending", async () => {
    const rows = await leaderboardRows(fakeSql([
      { player: "a", gold: 50, builds: 0, research: 0 },   // 50
      { player: "b", gold: 0, builds: 0, research: 3 },    // 300
      { player: "c", gold: 10, builds: 4, research: 0 },   // 210
    ]));
    expect(rows.map((r) => r.player)).toEqual(["b", "c", "a"]);
    expect(rows[0]!.score).toBe(300);
  });

  it("caps the board at the top LEADERBOARD_SIZE", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ player: `p${i}`, gold: i, builds: 0, research: 0 }));
    const rows = await leaderboardRows(fakeSql(many));
    expect(rows).toHaveLength(10);
    expect(rows[0]!.player).toBe("p14"); // highest gold ranks first
  });
});

describe("buildLeaderboardEmbed (§9)", () => {
  it("renders a ranked list with medals and mentions", async () => {
    const embed = await buildLeaderboardEmbed(fakeSql([
      { player: "111", gold: 500, builds: 1, research: 0 },
    ]));
    const json = embed.toJSON();
    expect(json.title).toContain("Leaderboard");
    expect(json.description).toContain("🥇");
    expect(json.description).toContain("<@111>");
    expect(json.description).toContain("550"); // 500 + 1*50
  });

  it("shows an empty-state when no renown has been earned", async () => {
    const embed = await buildLeaderboardEmbed(fakeSql([]));
    expect(embed.toJSON().description).toContain("first");
  });
});
