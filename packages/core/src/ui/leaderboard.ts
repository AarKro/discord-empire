/**
 * Realm leaderboard (framework spec §9) — a cross-continent ranking of players by
 * an aggregate "renown" score. Players are global (identity keyed by discord id,
 * position is per-continent), so the board spans every continent at once.
 *
 * The score is a PLACEHOLDER weighting of the three progression axes — gold on
 * hand, buildings completed, research unlocked. The weights are tunable constants
 * to be revisited once the game is feature-complete; the query + render below are
 * the stable part.
 */
import type { Sql } from "@empire/db";
import { EmbedBuilder } from "discord.js";

/** Placeholder renown weights (§9) — tune when feature-complete. */
export const BUILD_WEIGHT = 50;
export const RESEARCH_WEIGHT = 100;
/** How many players the board shows. */
export const LEADERBOARD_SIZE = 10;

export interface LeaderboardRow {
  player: string;
  gold: number;
  builds: number;
  research: number;
  score: number;
}

/** score = gold + builds·BUILD_WEIGHT + research·RESEARCH_WEIGHT (placeholder). */
export function renownScore(r: { gold: number; builds: number; research: number }): number {
  return r.gold + r.builds * BUILD_WEIGHT + r.research * RESEARCH_WEIGHT;
}

/**
 * Rank every registered player by renown across all continents. Gold is derived
 * from `balances`; builds/research from their completed/done rows. Returns the
 * top LEADERBOARD_SIZE, score-descending.
 */
export async function leaderboardRows(sql: Sql): Promise<LeaderboardRow[]> {
  // No ::int casts: int8 columns (balances.amount, count(*)) come back as JS
  // numbers via the driver's global bigint parser (see @empire/db openDb), and
  // ::int (int4) would add a needless 2.1B overflow cliff on gold.
  const rows = await sql<{ player: string; gold: number; builds: number; research: number }[]>`
    SELECT p.discord_user_id AS player,
           COALESCE(b.amount, 0) AS gold,
           COALESCE(bc.n, 0)     AS builds,
           COALESCE(rc.n, 0)     AS research
      FROM players p
      LEFT JOIN balances b
        ON b.owner_kind = 'player' AND b.owner_id = p.discord_user_id AND b.currency = 'gold'
      LEFT JOIN (SELECT owner_id, count(*) AS n FROM build_queue WHERE status = 'completed' GROUP BY owner_id) bc
        ON bc.owner_id = p.discord_user_id
      LEFT JOIN (SELECT owner_id, count(*) AS n FROM research WHERE status = 'done' GROUP BY owner_id) rc
        ON rc.owner_id = p.discord_user_id
  `;
  return rows
    .map((r) => ({ ...r, score: renownScore(r) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, LEADERBOARD_SIZE);
}

/** The /leaderboard embed — a ranked list of the realm's most renowned. */
export async function buildLeaderboardEmbed(sql: Sql): Promise<EmbedBuilder> {
  const rows = await leaderboardRows(sql);
  const embed = new EmbedBuilder().setTitle("🏆 Realm Leaderboard");
  if (rows.length === 0) {
    embed.setDescription("No renown has been earned yet. Be the first.");
    return embed;
  }
  const medals = ["🥇", "🥈", "🥉"];
  const lines = rows.map((r, i) => {
    const rank = medals[i] ?? `**${i + 1}.**`;
    return `${rank} <@${r.player}> — **${r.score}** renown _(${r.gold}g · ${r.builds} built · ${r.research} researched)_`;
  });
  embed.setDescription(lines.join("\n"));
  embed.setFooter({ text: "Renown across all continents · scoring is provisional" });
  return embed;
}
