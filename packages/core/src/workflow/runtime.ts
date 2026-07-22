/**
 * Workflow runtime (framework spec §7): the I/O half of the engine. It listens
 * on the bus, matches triggers, creates/loads persisted instances (per player /
 * npc / world), runs the pure `decide()` core, dispatches actions through the
 * capability action registry, arms timers, and handles per-action on_error
 * (abort | retry(n) | goto). Instances survive restarts (persisted in
 * workflow_instances; timers reconciled from `timer_at` on boot).
 */
import type { Workflow } from "@empire/content-schemas";
import type { BusEvent, EventBus } from "../bus.js";
import type { CapabilityContext, CapabilityRegistry } from "../capability.js";
import type { Logger } from "../logger.js";
import type { Sql } from "@empire/db";
import { jsonParam } from "@empire/db";
import { ulid } from "ulid";
import { availableOptions, decide, entry, parseOnError, scopeMatches, type Stimulus, type TransitionDecision } from "./engine.js";
import { loadGuardScope, resolveSource, interpolate, DIALOGUE_OPTION_PREFIX, EMPTY_SCOPE, type GuardScope } from "../dialogue.js";
import { parseDuration } from "./duration.js";

/** A persisted instance row's routing/context fields (as advance() needs them). */
interface InstanceRow {
  id: string;
  workflow_id: string;
  scope: "player" | "npc" | "world";
  scope_key: string;
  state: string;
  context: Record<string, unknown>;
  correlation_id: string | null;
}

export interface RuntimeDeps {
  sql: Sql;
  bus: EventBus;
  registry: CapabilityRegistry;
  logger: Logger;
  /** Context factory for action dispatch (bots supply their own gateway etc). */
  makeContext: (correlationId: string) => CapabilityContext;
}

export class WorkflowRuntime {
  private readonly byTrigger = new Map<string, Workflow[]>();
  private readonly byId = new Map<string, Workflow>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Workflow ids that reference player game-state (guards/options) — the only
   *  ones for which we load a real GuardScope; the rest run against EMPTY_SCOPE. */
  private readonly needsScope = new Set<string>();
  private botId?: string;

  constructor(
    workflows: Workflow[],
    private readonly deps: RuntimeDeps,
  ) {
    for (const wf of workflows) {
      this.byId.set(wf.id, wf);
      if (Object.values(wf.states).some((s) => s.guards.length > 0 || s.options.length > 0)) {
        this.needsScope.add(wf.id);
      }
      if (!wf.trigger) continue;
      const list = this.byTrigger.get(wf.trigger.event) ?? [];
      list.push(wf);
      this.byTrigger.set(wf.trigger.event, list);
    }
  }

  /** The owning bot's id (constant); cached from the context factory. */
  private bot(): string {
    return (this.botId ??= this.deps.makeContext("wf").bot);
  }

  /**
   * Guard scope for evaluating a workflow's guards/options: the player's
   * game-state (for player-scoped, state-bearing workflows) plus the instance's
   * accumulated context, so guards can branch on `context.*`.
   */
  private async scopeFor(wf: Workflow, scopeKey: string, context: Record<string, unknown>): Promise<GuardScope> {
    const base = wf.scope === "player" && this.needsScope.has(wf.id) ? await loadGuardScope(this.deps.sql, scopeKey) : EMPTY_SCOPE;
    return { ...base, context };
  }

  /**
   * Apply a state's `set:` on entry (§7 per-instance context): resolve each source
   * against the current event + prior context and persist the merged context.
   * `context.*` sources read the pre-set values. No-op when the state sets nothing.
   */
  private async applyContext(id: string, wf: Workflow, stateId: string, evt: BusEvent | null, prev: Record<string, unknown>): Promise<Record<string, unknown>> {
    const setSpec = wf.states[stateId]?.set ?? {};
    const keys = Object.keys(setSpec);
    if (keys.length === 0) return prev;
    const next = { ...prev };
    for (const key of keys) next[key] = resolveSource(setSpec[key]!, evt, prev);
    await this.deps.sql`UPDATE workflow_instances SET context = ${jsonParam(this.deps.sql, next)}, updated_at = now() WHERE id = ${id}`;
    return next;
  }

  /**
   * If a state carries a player-facing prompt (§5.4 dialogue-as-workflow),
   * publish the render event the `render` capability turns into thread messages:
   * dialogue.opened on the initial state, dialogue.closed on a final state, else
   * dialogue.node — with the bot line and the guard-filtered option buttons.
   */
  private async renderPrompt(wf: Workflow, stateId: string, scope: GuardScope, evt: BusEvent | null, playerId: string, opened: boolean): Promise<void> {
    const state = wf.states[stateId];
    if (!state?.prompt) return;
    const ctx = scope.context ?? {};
    const type = opened ? "dialogue.opened" : state.final ? "dialogue.closed" : "dialogue.node";
    // Prompt + labels weave in remembered context ({{context.x}}).
    const options = availableOptions(state, scope).map((o) => ({ id: `${DIALOGUE_OPTION_PREFIX}${o.id}`, label: interpolate(o.label, evt, ctx), kind: o.kind }));
    await this.deps.bus.publish({
      type,
      guildId: evt?.guildId ?? null,
      actor: { kind: "player", id: playerId },
      subject: { kind: "npc", id: this.bot() },
      payload: { dialogue: wf.id, node: stateId, text: interpolate(state.prompt, evt, ctx), options },
    });
  }

  /** Publish the events a chosen option emits (player as actor, npc as subject). */
  private async publishEmits(emits: TransitionDecision["emits"], playerId: string, evt: BusEvent | null, correlationId: string, context: Record<string, unknown>): Promise<void> {
    for (const e of emits) {
      await this.deps.bus.publish({
        type: e.type,
        guildId: evt?.guildId ?? null,
        actor: { kind: "player", id: playerId },
        subject: { kind: "npc", id: this.bot() },
        payload: interpolate(e.payload ?? {}, evt, context),
        correlationId,
      });
    }
  }

  /** On boot: re-arm any timers whose deadline is stored on active instances. */
  async recoverTimers(): Promise<void> {
    const rows = await this.deps.sql<{ id: string; workflow_id: string; state: string; timer_at: Date | null }[]>`
      SELECT id, workflow_id, state, timer_at FROM workflow_instances
      WHERE status = 'active' AND timer_at IS NOT NULL
    `;
    for (const r of rows) {
      if (!r.timer_at) continue;
      const delay = Math.max(0, new Date(r.timer_at).getTime() - Date.now());
      this.armTimer(r.id, r.workflow_id, r.state, delay);
    }
  }

  /** Bus handler: match triggers, advance matching instances. */
  async onEvent(evt: BusEvent): Promise<void> {
    // 1) Trigger new instances.
    for (const wf of this.byTrigger.get(evt.type) ?? []) {
      if (!this.passesFilter(wf, evt)) continue;
      await this.startInstance(wf, evt);
    }
    // 2) Advance existing instances whose current state listens for this event
    //    AND whose scope owns it (§7): a per-player instance only advances on
    //    events attributed to that player, per-npc on that npc as subject.
    const instances = await this.deps.sql<InstanceRow[]>`
      SELECT id, workflow_id, scope, scope_key, state, context, correlation_id FROM workflow_instances WHERE status = 'active'
    `;
    for (const inst of instances) {
      const wf = this.byId.get(inst.workflow_id);
      if (!wf) continue;
      if (!scopeMatches(inst.scope, inst.scope_key, evt)) continue;
      // Correlation gate (§7): when the event and the instance both carry a
      // correlation id, only the instance that owns it advances — so concurrent
      // same-scope instances (two builds, two quests) are told apart.
      if (evt.correlationId && inst.correlation_id && evt.correlationId !== inst.correlation_id) continue;
      await this.advance(inst, wf, { kind: "event", eventType: evt.type, payload: evt.payload }, evt);
    }
  }

  private passesFilter(wf: Workflow, _evt: BusEvent): boolean {
    const chance = wf.trigger?.filter?.random_chance;
    if (typeof chance === "number") return Math.random() < chance;
    return true;
  }

  private async startInstance(wf: Workflow, evt: BusEvent): Promise<void> {
    const correlationId = evt.correlationId ?? `wf_${ulid()}`;
    const scopeKey =
      wf.scope === "player" ? (evt.actor?.id ?? "unknown") :
      wf.scope === "npc" ? (evt.subject?.id ?? String(wf.context.npc ?? "npc")) :
      "world";
    const id = `wfi_${ulid()}`;
    const scope = await this.scopeFor(wf, scopeKey, wf.context);
    const dec = entry(wf, scope);
    if (dec.nextState === null) return; // guards blocked entry
    // Singleton workflows (wf.singleton) only spawn when no instance for this
    // scope key is already active — a race-safe conditional insert that guards a
    // re-delivered trigger (bus replay on reboot) from duplicating a perpetual/
    // timer-loop workflow. If nothing was inserted, one is already running and
    // the recovered timer keeps it alive. Non-singleton workflows spawn one
    // instance per firing (a per-build charge, a random appearance).
    const status = dec.final ? "final" : "active";
    const contextJson = jsonParam(this.deps.sql, wf.context);
    const inserted = wf.singleton
      ? await this.deps.sql`
          INSERT INTO workflow_instances (id, workflow_id, scope, scope_key, state, context, correlation_id, status)
          SELECT ${id}, ${wf.id}, ${wf.scope}, ${scopeKey}, ${dec.nextState}, ${contextJson}, ${correlationId}, ${status}
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_instances
            WHERE workflow_id = ${wf.id} AND scope_key = ${scopeKey} AND status = 'active'
          )
        `
      : await this.deps.sql`
          INSERT INTO workflow_instances (id, workflow_id, scope, scope_key, state, context, correlation_id, status)
          VALUES (${id}, ${wf.id}, ${wf.scope}, ${scopeKey}, ${dec.nextState}, ${contextJson}, ${correlationId}, ${status})
        `;
    if (inserted.count === 0) return;
    const context = await this.applyContext(id, wf, dec.nextState, evt, wf.context);
    scope.context = context;
    const errGoto = await this.runActions(dec.actions, evt, correlationId, wf, dec.nextState, context);
    if (errGoto !== null) {
      await this.forceTransition(id, wf, errGoto, evt, correlationId);
      return;
    }
    await this.finishOrArm(id, wf, dec);
    await this.renderPrompt(wf, dec.nextState, scope, evt, scopeKey, true);
  }

  private async advance(inst: InstanceRow, wf: Workflow, stimulus: Stimulus, evt: BusEvent | null): Promise<void> {
    const scope = await this.scopeFor(wf, inst.scope_key, inst.context);
    const dec = decide(wf, inst.state, stimulus, scope);
    if (dec.nextState === null) return;
    const correlationId = inst.correlation_id ?? `wf_${ulid()}`;
    await this.deps.sql`
      UPDATE workflow_instances SET state = ${dec.nextState}, updated_at = now(),
        status = ${dec.final ? "final" : "active"}
      WHERE id = ${inst.id}
    `;
    // Merge the target's `set:`, then use that context for emits/actions/render.
    const context = await this.applyContext(inst.id, wf, dec.nextState, evt, inst.context);
    scope.context = context;
    // A chosen option's emits fire on the transition, before entering the target.
    await this.publishEmits(dec.emits, inst.scope_key, evt, correlationId, context);
    const errGoto = await this.runActions(dec.actions, evt, correlationId, wf, dec.nextState, context);
    if (errGoto !== null) {
      await this.forceTransition(inst.id, wf, errGoto, evt, correlationId);
      return;
    }
    await this.finishOrArm(inst.id, wf, dec);
    await this.renderPrompt(wf, dec.nextState, scope, evt, inst.scope_key, false);
  }

  /**
   * on_error: <state> (§7) — a failed action moves the instance to the named
   * error state, running that state's actions. One error-hop only: if the
   * error state's own actions fail with another goto, we abort instead of
   * looping between error states.
   */
  private async forceTransition(
    id: string,
    wf: Workflow,
    stateId: string,
    evt: BusEvent | null,
    correlationId: string,
    depth = 0,
  ): Promise<void> {
    const target = wf.states[stateId];
    if (!target) {
      this.deps.logger.error({ workflow: wf.id, stateId }, "on_error goto target does not exist");
      await this.deps.sql`UPDATE workflow_instances SET status = 'failed', updated_at = now() WHERE id = ${id}`;
      return;
    }
    await this.deps.sql`
      UPDATE workflow_instances SET state = ${stateId}, timer_at = NULL, updated_at = now(),
        status = ${target.final ? "final" : "active"}
      WHERE id = ${id}
    `;
    this.deps.logger.warn({ workflow: wf.id, stateId }, "workflow moved to on_error state");
    // on_error hop: run the error state's actions (no context templating here — an
    // error transition isn't a normal set:-bearing entry).
    const errGoto = await this.runActions(target.actions, evt, correlationId, wf, stateId, {});
    if (errGoto !== null) {
      if (depth >= 1) {
        this.deps.logger.error({ workflow: wf.id, stateId }, "error state failed too; aborting instance");
        await this.deps.sql`UPDATE workflow_instances SET status = 'failed', updated_at = now() WHERE id = ${id}`;
        await this.deps.bus.publish({ type: "workflow.failed", payload: { workflow: wf.id, state: stateId }, correlationId });
        return;
      }
      await this.forceTransition(id, wf, errGoto, evt, correlationId, depth + 1);
      return;
    }
    await this.finishOrArm(id, wf, {
      nextState: stateId,
      actions: target.actions,
      emits: [],
      final: target.final,
      timerMs: target.timer ? parseDuration(target.timer.after) : null,
      timerGoto: target.timer?.goto ?? null,
    });
  }

  private async finishOrArm(
    id: string,
    wf: Workflow,
    dec: ReturnType<typeof decide>,
  ): Promise<void> {
    if (dec.final) {
      this.clearTimer(id);
      return;
    }
    if (dec.timerMs !== null && dec.nextState) {
      // Bind the deadline as ISO text and let Postgres cast to timestamptz —
      // postgres-js can't serialize a JS Date on the prepared-statement path
      // (same quirk jsonParam sidesteps for jsonb).
      const at = new Date(Date.now() + dec.timerMs).toISOString();
      await this.deps.sql`UPDATE workflow_instances SET timer_at = ${at} WHERE id = ${id}`;
      this.armTimer(id, wf.id, dec.nextState, dec.timerMs);
    } else {
      // Entering a state with no timer — drop any deadline carried from a prior
      // one (e.g. charging→building) so no stale timer lingers.
      this.clearTimer(id);
      await this.deps.sql`UPDATE workflow_instances SET timer_at = NULL WHERE id = ${id}`;
    }
  }

  private armTimer(id: string, workflowId: string, state: string, delayMs: number): void {
    this.clearTimer(id);
    const t = setTimeout(() => {
      void this.onTimer(id, workflowId, state);
    }, delayMs);
    if (typeof t.unref === "function") t.unref();
    this.timers.set(id, t);
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  private async onTimer(id: string, workflowId: string, state: string): Promise<void> {
    const wf = this.byId.get(workflowId);
    if (!wf) return;
    const [inst] = await this.deps.sql<InstanceRow[]>`
      SELECT id, workflow_id, scope, scope_key, state, context, correlation_id FROM workflow_instances WHERE id = ${id} AND status = 'active'
    `;
    if (!inst || inst.state !== state) return;
    await this.advance(inst, wf, { kind: "timer" }, this.instanceEvent(inst));
  }

  /**
   * A synthetic event carrying an instance's identity, passed to actions on a
   * TIMER transition (which has no bus event) so a timeout/expiry state can still
   * act as the player/npc it belongs to — reads its actor + correlation.
   */
  private instanceEvent(inst: InstanceRow): BusEvent {
    return {
      dbId: "0", eventId: `wf_timer_${inst.id}`, type: "workflow.timer", ts: "", guildId: null,
      actor: inst.scope === "player" ? { kind: "player", id: inst.scope_key } : null,
      subject: inst.scope === "npc" ? { kind: "npc", id: inst.scope_key } : null,
      payload: {}, correlationId: inst.correlation_id,
    };
  }

  /**
   * Run each action via its capability handler with on_error handling (§7).
   * Returns the on_error goto target if a failed action demands a transition
   * to an error state (remaining actions are skipped), else null.
   */
  private async runActions(
    actions: Record<string, unknown>[],
    evt: BusEvent | null,
    correlationId: string,
    wf: Workflow,
    stateId: string,
    context: Record<string, unknown>,
  ): Promise<string | null> {
    const ctx = this.deps.makeContext(correlationId);
    const onErr = parseOnError(wf.states[stateId]?.on_error);
    for (const action of actions) {
      for (const [verb, rawArgs] of Object.entries(action)) {
        // Weave remembered context into the args ({{context.x}}) before dispatch.
        const args = interpolate(rawArgs as Record<string, unknown>, evt, context);
        if (verb === "emit") {
          const spec = args as { type: string; payload?: Record<string, unknown> };
          await this.deps.bus.publish({
            type: spec.type,
            ...(spec.payload ? { payload: spec.payload } : {}),
            correlationId,
          });
          continue;
        }
        const handler = this.deps.registry.action(verb);
        if (!handler) {
          this.deps.logger.error({ verb }, "no capability exports this action");
          continue;
        }
        const goto = await this.dispatchWithRetry(handler, args, evt, ctx, onErr, verb, wf, correlationId);
        if (goto !== null) return goto;
      }
    }
    return null;
  }

  /**
   * Dispatch one action under the state's on_error policy (§7):
   *   retry(n) — n extra attempts, then fall through to abort semantics;
   *   abort    — emit workflow.failed and stop;
   *   <state>  — return the error state so the caller transitions to it.
   */
  private async dispatchWithRetry(
    handler: (a: Record<string, unknown>, e: BusEvent | null, c: CapabilityContext) => unknown,
    args: Record<string, unknown>,
    evt: BusEvent | null,
    ctx: CapabilityContext,
    onErr: ReturnType<typeof parseOnError>,
    verb: string,
    wf: Workflow,
    correlationId: string,
  ): Promise<string | null> {
    const attempts = onErr.kind === "retry" ? (onErr.n ?? 1) + 1 : 1;
    for (let i = 0; i < attempts; i++) {
      try {
        await handler(args, evt, ctx);
        return null;
      } catch (err) {
        this.deps.logger.warn({ err, verb, attempt: i + 1 }, "action failed");
        if (i === attempts - 1) {
          // Exhausted; apply terminal policy.
          if (onErr.kind === "goto" && onErr.state) return onErr.state;
          await this.deps.bus.publish({ type: "workflow.failed", payload: { workflow: wf.id, verb }, correlationId });
          return null;
        }
      }
    }
    return null;
  }
}
