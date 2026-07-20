/**
 * Dialogue tree resolution (framework spec §5.4). Trees are data: nodes with bot
 * text, player options with guards, gotos, and emitted events — the same
 * node/transition model as workflows. Pure & unit-testable; no Discord here.
 *
 * Haggling (offers/counteroffers against a hidden floor) is expressible as guard
 * + goto + emit data, so it is authorable without code.
 */
import type { Dialogue, DialogueNode, DialogueOption } from "@empire/content-schemas";

/** Game-state facts a guard can reference (§7 guards). */
export interface GuardScope {
  gold: number;
  reputation: Record<string, number>;
  flags: Record<string, boolean>;
  position?: { district: string | null };
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

export class DialogueRunner {
  private readonly nodes: Map<string, DialogueNode>;
  private current: string;

  constructor(tree: Dialogue) {
    this.nodes = new Map(tree.nodes.map((node) => [node.id, node]));
    if (!this.nodes.has(tree.start)) throw new Error(`dialogue start node "${tree.start}" not found`);
    this.current = tree.start;
  }

  get node(): DialogueNode {
    return this.nodes.get(this.current)!;
  }

  /** Options visible to a player given their game-state scope (guards applied). */
  availableOptions(scope: GuardScope): DialogueOption[] {
    return this.node.options.filter((option) => !option.guard || evalGuard(option.guard.expr, scope));
  }

  /** Take an option by id; returns the emitted events and whether the tree ended. */
  choose(optionId: string, scope: GuardScope): { emit: DialogueOption["emit"]; done: boolean } {
    const option = this.availableOptions(scope).find((candidate) => candidate.id === optionId);
    if (!option) throw new Error(`option "${optionId}" not available at node "${this.current}"`);
    if (option.goto) {
      if (!this.nodes.has(option.goto)) throw new Error(`goto target "${option.goto}" not found`);
      this.current = option.goto;
    }
    const done = this.node.final;
    return { emit: option.emit, done };
  }
}
