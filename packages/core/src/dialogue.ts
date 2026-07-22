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
  /** Per-instance workflow context (values a state's `set:` accumulated). */
  context?: Record<string, unknown>;
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
  if (parts[0] === "context") return scope.context?.[parts.slice(1).join(".")];
  return undefined;
}

/** Minimal event shape a `set:` source can read from. */
export interface SourceEvent {
  payload?: Record<string, unknown> | null;
  actor?: { id: string } | null;
  subject?: { id: string } | null;
  correlationId?: string | null;
  guildId?: string | null;
}

/**
 * Resolve a `set:` source expression to a value (§7 per-instance context). Mirrors
 * the guard grammar — deliberately tiny:
 *   event.payload.<path> | event.actor.id | event.subject.id
 *   event.correlationId | event.guildId | context.<path> | 'literal' | <number>
 */
export function resolveSource(expr: string, evt: SourceEvent | null, context: Record<string, unknown>): unknown {
  const e = expr.trim();
  const quoted = e.match(/^'(.*)'$/) ?? e.match(/^"(.*)"$/);
  if (quoted) return quoted[1];
  if (e.startsWith("event.")) {
    const path = e.slice("event.".length);
    if (path === "correlationId") return evt?.correlationId ?? null;
    if (path === "guildId") return evt?.guildId ?? null;
    if (path === "actor.id") return evt?.actor?.id ?? null;
    if (path === "subject.id") return evt?.subject?.id ?? null;
    if (path.startsWith("payload.")) return digPath(evt?.payload ?? {}, path.slice("payload.".length));
    return undefined;
  }
  if (e.startsWith("context.")) return digPath(context, e.slice("context.".length));
  const n = Number(e);
  return Number.isNaN(n) ? e : n; // bare literal: number if numeric, else the raw string
}

function digPath(obj: Record<string, unknown> | null | undefined, path: string): unknown {
  let cur: unknown = obj ?? {};
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Substitute `{{expr}}` templates in a value against the event + instance context
 * (§7), so prompts / labels / action args / emit payloads can weave in remembered
 * data. Recurses into objects/arrays. A WHOLE-string template (`"{{expr}}"`) returns
 * the resolved value with its type intact (so `gold: "{{context.reward}}"` stays a
 * number); a mixed string interpolates each `{{expr}}` into text. Non-strings pass
 * through untouched.
 */
export function interpolate<T>(value: T, evt: SourceEvent | null, context: Record<string, unknown>): T {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{([^}]+)\}\}$/);
    if (whole) return resolveSource(whole[1]!.trim(), evt, context) as T;
    return value.replace(/\{\{([^}]+)\}\}/g, (_m, expr: string) => String(resolveSource(expr.trim(), evt, context) ?? "")) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, evt, context)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, evt, context);
    return out as T;
  }
  return value;
}
