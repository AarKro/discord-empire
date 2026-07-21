/**
 * Custom workflow engine (framework spec §7). NOT built on XState (tech spec):
 * it is the product's core. Workflows are declarative state machines —
 * trigger → states → actions → emitted events.
 *
 * This module is the PURE transition core (unit-tested): given a workflow, a
 * current state, and a stimulus (event or timer), it decides the next state and
 * the actions to run. All I/O (persistence, action dispatch, emit) lives in the
 * runtime (see runtime.ts), so transitions/guards/timers are testable without a
 * database or Discord.
 */
import type { DialogueOption, Workflow, WorkflowState } from "@empire/content-schemas";
import { evalGuard, type GuardScope } from "../dialogue.js";
import { parseDuration } from "./duration.js";

/** The event a player's option click arrives as; its payload carries `option`. */
export const CHOOSE_EVENT = "dialogue.choose";

export interface Stimulus {
  kind: "event" | "timer";
  /** For events: the event type. */
  eventType?: string;
  /** Payload used for filter checks / option resolution (random_chance by caller). */
  payload?: Record<string, unknown>;
}

export interface TransitionDecision {
  /** Next state id, or null if the stimulus does not apply here. */
  nextState: string | null;
  /** Actions to run on entering the next state. */
  actions: Record<string, unknown>[];
  /** Events a chosen option emits on the transition (published before entry). */
  emits: NonNullable<DialogueOption["emit"]>;
  /** Whether the next state is final. */
  final: boolean;
  /** Timer to arm on the next state, in ms, if any. */
  timerMs: number | null;
  /** Timer goto target, if any. */
  timerGoto: string | null;
}

/** Options visible to a player at a state given their guard scope (§5.4). */
export function availableOptions(state: WorkflowState, scope: GuardScope): DialogueOption[] {
  return state.options.filter((option) => !option.guard || evalGuard(option.guard.expr, scope));
}

/** True if every guard on a state passes for the given scope. */
export function guardsPass(state: WorkflowState, scope: GuardScope): boolean {
  return state.guards.every((g) => evalGuard(g.expr, scope));
}

/**
 * Decide the transition for a stimulus at `currentStateId`. Returns
 * nextState: null when nothing matches (the machine stays put).
 */
export function decide(
  wf: Workflow,
  currentStateId: string,
  stimulus: Stimulus,
  scope: GuardScope = { gold: 0, reputation: {}, flags: {} },
): TransitionDecision {
  const state = wf.states[currentStateId];
  if (!state) throw new Error(`unknown state "${currentStateId}" in workflow "${wf.id}"`);

  let targetId: string | null = null;
  let emits: TransitionDecision["emits"] = [];

  if (stimulus.kind === "timer") {
    targetId = state.timer?.goto ?? null;
  } else if (stimulus.eventType === CHOOSE_EVENT && state.options.length > 0) {
    // A player picked an option: resolve it, honour its guard, take its goto and
    // emits. An unknown/guard-failed option is a stale or blocked click — ignore.
    const option = state.options.find((o) => o.id === String(stimulus.payload?.option ?? ""));
    if (!option) return empty();
    if (option.guard && !evalGuard(option.guard.expr, scope)) return empty();
    targetId = option.goto ?? null;
    emits = option.emit ?? [];
  } else if (stimulus.eventType) {
    targetId = state.on[stimulus.eventType] ?? null;
  }

  if (targetId === null) return empty();

  const target = wf.states[targetId];
  if (!target) throw new Error(`transition to unknown state "${targetId}" in workflow "${wf.id}"`);

  // Guards apply to the target state's entry.
  if (!guardsPass(target, scope)) return empty();

  return {
    nextState: targetId,
    actions: target.actions,
    emits,
    final: target.final,
    timerMs: target.timer ? parseDuration(target.timer.after) : null,
    timerGoto: target.timer?.goto ?? null,
  };
}

/** The initial-state entry decision when an instance is created. */
export function entry(wf: Workflow, scope: GuardScope = { gold: 0, reputation: {}, flags: {} }): TransitionDecision {
  const state = wf.states[wf.initial];
  if (!state) throw new Error(`initial state "${wf.initial}" missing in workflow "${wf.id}"`);
  if (!guardsPass(state, scope)) return empty();
  return {
    nextState: wf.initial,
    actions: state.actions,
    emits: [],
    final: state.final,
    timerMs: state.timer ? parseDuration(state.timer.after) : null,
    timerGoto: state.timer?.goto ?? null,
  };
}

/**
 * Does an event belong to a given instance's scope? (§7 scopes.)
 * Mirrors how scope_key is derived at instance creation: `player` keys on the
 * event's actor, `npc` on its subject, `world` matches everything. Events that
 * cannot be attributed (missing actor/subject) advance nothing scoped.
 */
export function scopeMatches(
  scope: "player" | "npc" | "world",
  scopeKey: string,
  evt: { actor?: { kind: string; id: string } | null; subject?: { kind: string; id: string } | null },
): boolean {
  if (scope === "world") return true;
  if (scope === "player") return evt.actor?.kind === "player" && evt.actor.id === scopeKey;
  return evt.subject?.id === scopeKey;
}

/** Parse an `on_error` directive into a normalized policy. */
export function parseOnError(directive: string | undefined): { kind: "abort" | "retry" | "goto"; n?: number; state?: string } {
  if (!directive || directive === "abort") return { kind: "abort" };
  const retry = directive.match(/^retry\((\d+)\)$/);
  if (retry) return { kind: "retry", n: Number(retry[1]) };
  return { kind: "goto", state: directive };
}

function empty(): TransitionDecision {
  return { nextState: null, actions: [], emits: [], final: false, timerMs: null, timerGoto: null };
}
