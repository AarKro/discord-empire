/**
 * Guard evaluation + player scope loading (framework spec §5.4, §7). Guards are
 * tiny data expressions (`player.gold >= 120`) shared by dialogue options and
 * workflow state guards; dialogue itself is now expressed as workflows (states
 * with prompts + options), so the tree runner that once lived here is retired —
 * the workflow engine resolves options and transitions. Pure & unit-testable.
 */
import type { Sql } from "@empire/db";
import { readBalance } from "@empire/db";

/** Custom-id prefix for the option buttons a prompt-bearing state renders. */
export const DIALOGUE_OPTION_PREFIX = "dlg:";

/** Game-state facts a guard can reference (§7 guards). */
export interface GuardScope {
  gold: number;
  reputation: Record<string, number>;
  flags: Record<string, boolean>;
  position?: { district: string | null };
}

/** The zero scope — used by workflows that reference no player game-state. */
export const EMPTY_SCOPE: GuardScope = { gold: 0, reputation: {}, flags: {} };

/** Load a player's guard scope (§7 guards) from game state. Reads only. */
export async function loadGuardScope(sql: Sql, playerId: string): Promise<GuardScope> {
  const gold = await readBalance(sql, "player", playerId, "gold");
  const reputationRows = await sql<{ npc_id: string; score: number }[]>`
    SELECT npc_id, score FROM reputation WHERE player_id = ${playerId}
  `;
  const [player] = await sql<{ flags: Record<string, boolean>; position_district_id: string | null }[]>`
    SELECT flags, position_district_id FROM players WHERE discord_user_id = ${playerId}
  `;
  return {
    gold,
    reputation: Object.fromEntries(reputationRows.map((rep) => [rep.npc_id, rep.score])),
    flags: player?.flags ?? {},
    position: { district: player?.position_district_id ?? null },
  };
}

/**
 * Evaluate a guard expression against a scope. Supports the documented forms:
 *   player.gold >= 50
 *   player.reputation.merchant >= 3
 *   player.flags.met_aldric
 *   player.position == <district>
 * Deliberately tiny — not a general expression engine.
 */
export function evalGuard(expr: string, scope: GuardScope): boolean {
  const trimmed = expr.replace(/^player\./, "").trim();

  const cmp = trimmed.match(/^([\w.]+)\s*(>=|<=|==|>|<)\s*(.+)$/);
  if (cmp) {
    const [, lhs, op, rhsRaw] = cmp as unknown as [string, string, string, string];
    const left = resolvePath(lhs, scope);
    const rhs = rhsRaw.trim();
    const rightNum = Number(rhs);
    if (!Number.isNaN(rightNum)) {
      const leftNum = Number(left);
      switch (op) {
        case ">=": return leftNum >= rightNum;
        case "<=": return leftNum <= rightNum;
        case ">": return leftNum > rightNum;
        case "<": return leftNum < rightNum;
        case "==": return leftNum === rightNum;
      }
    }
    if (op === "==") return String(left) === rhs;
    return false;
  }

  // Bare truthiness, e.g. "flags.met_aldric" / "research.trade_routes".
  return Boolean(resolvePath(trimmed, scope));
}

function resolvePath(path: string, scope: GuardScope): unknown {
  const parts = path.split(".");
  if (parts[0] === "gold") return scope.gold;
  if (parts[0] === "reputation") return scope.reputation[parts[1] ?? ""] ?? 0;
  if (parts[0] === "flags") return scope.flags[parts[1] ?? ""] ?? false;
  if (parts[0] === "position") return scope.position?.district ?? null;
  return undefined;
}
