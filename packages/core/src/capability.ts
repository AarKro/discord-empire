/**
 * Capability registry (framework spec §1.2, §5, §7).
 *
 * A bot is assembled from composable capability modules — "capabilities over
 * inheritance". Each capability declares the events it consumes and the actions
 * (verbs) it exports. The action registry is discoverable, which is the
 * foundation for a future visual workflow editor (§7).
 */
import type { BusEvent, EventBus } from "./bus.js";
import type { Gateway } from "./gateway.js";
import type { PersonaResolver } from "./persona.js";
import type { Sql } from "@empire/db";
import type { Logger } from "./logger.js";

/** Services every capability is handed at registration. */
export interface CapabilityContext {
  bot: string;
  sql: Sql;
  bus: EventBus;
  gateway: Gateway;
  personas: PersonaResolver;
  logger: Logger;
  /** Arbitrary per-bot config from the manifest's `content` block. */
  config: Record<string, unknown>;
}

/** A workflow/dialogue action handler: `verb -> (args, ctx) -> void`. */
export type ActionHandler = (
  args: Record<string, unknown>,
  evt: BusEvent | null,
  ctx: CapabilityContext,
) => Promise<void> | void;

export interface Capability {
  /** Catalog id, e.g. "trade", "presence.voice". */
  readonly name: string;
  /** Event type patterns (prefix match, e.g. "trade.") this capability handles. */
  readonly consumes: readonly string[];
  /** Verbs this capability exports to the workflow/dialogue action registry. */
  readonly actions: Readonly<Record<string, ActionHandler>>;
  /** Handle a bus event (called for events matching `consumes`). */
  handle?(evt: BusEvent, ctx: CapabilityContext): Promise<void> | void;
  /** Boot hook (e.g. open stall, join VC). */
  init?(ctx: CapabilityContext): Promise<void> | void;
}

export class CapabilityRegistry {
  private readonly caps = new Map<string, Capability>();
  private readonly actionIndex = new Map<string, { cap: string; handler: ActionHandler }>();

  register(cap: Capability): void {
    if (this.caps.has(cap.name)) throw new Error(`capability already registered: ${cap.name}`);
    this.caps.set(cap.name, cap);
    for (const [verb, handler] of Object.entries(cap.actions)) {
      if (this.actionIndex.has(verb)) {
        throw new Error(`action verb "${verb}" already exported by ${this.actionIndex.get(verb)!.cap}`);
      }
      this.actionIndex.set(verb, { cap: cap.name, handler });
    }
  }

  get(name: string): Capability | undefined {
    return this.caps.get(name);
  }

  list(): Capability[] {
    return [...this.caps.values()];
  }

  /** Resolve a workflow/dialogue action verb to its handler. */
  action(verb: string): ActionHandler | undefined {
    return this.actionIndex.get(verb)?.handler;
  }

  /** All capabilities whose `consumes` prefixes match an event type. */
  matching(eventType: string): Capability[] {
    return this.list().filter((c) => c.consumes.some((p) => eventType.startsWith(p)));
  }

  /** The discoverable action catalog (verb -> owning capability). */
  actionCatalog(): Record<string, string> {
    return Object.fromEntries([...this.actionIndex].map(([verb, v]) => [verb, v.cap]));
  }
}
