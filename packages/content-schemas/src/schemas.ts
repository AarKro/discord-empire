/**
 * Zod schemas for all YAML game content (framework spec §4, §5, §7, §8, §9).
 *
 * Runtime choice: Zod (tech spec "agent's choice", recommended). It validates
 * YAML content AND event payloads at boot/publish and produces readable,
 * path-scoped error messages — see `formatIssues`.
 */
import { z } from "zod";

// --- Duration strings like "90m", "10s", "2h" used by timers/schedules (§7). ---
export const Duration = z.string().regex(/^\d+(ms|s|m|h)$/, "expected a duration like 10s / 5m / 2h");

// --- Manifest (§4) ------------------------------------------------------------
export const Persona = z.object({
  nickname: z.string().min(1),
  avatar: z.string().optional(),
  locale_flavor: z.string().optional(),
});
export type Persona = z.infer<typeof Persona>;

export const Manifest = z.object({
  id: z.string().min(1),
  token_env: z.string().min(1),
  personas: z.record(z.string(), Persona),
  capabilities: z.array(z.string().min(1)).min(1),
  home: z.record(z.string(), z.object({ voice_channel: z.string() })).optional(),
  content: z
    .object({
      shop: z.string().optional(),
      voicelines: z.string().optional(),
      schedule: z.string().optional(),
      workflows: z.array(z.string()).optional(),
      // Continent ring (§9) — a travelling NPC's `travel` capability reads it to
      // walk between continents by their authored neighbours.
      continents: z.string().optional(),
    })
    .optional(),
});
export type Manifest = z.infer<typeof Manifest>;

// --- Shop (§5.3) --------------------------------------------------------------
export const ShopItem = z.object({
  item_id: z.string().min(1),
  name: z.string().min(1),
  base_price: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative(),
  // Optional hidden floor for haggling (§5.4), and reputation price scaling.
  floor_price: z.number().int().nonnegative().optional(),
  reputation_discount: z.number().min(0).max(1).optional(),
});
export type ShopItem = z.infer<typeof ShopItem>;

export const Shop = z.object({
  id: z.string().min(1),
  currency: z.string().default("gold"),
  items: z.array(ShopItem).min(1),
});
export type Shop = z.infer<typeof Shop>;

// --- Guards + player options (§5.4) — the pieces a dialogue workflow uses -----
export const Guard = z.object({
  expr: z.string().min(1), // e.g. "player.gold >= 50", "player.reputation.merchant >= 3"
});

// A player-facing choice on a workflow state's `prompt` (see WorkflowState): a
// button with an optional guard, a goto, and events it emits when chosen.
export const DialogueOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["button", "select", "modal"]).default("button"),
  guard: Guard.optional(),
  goto: z.string().optional(),
  emit: z.array(z.object({ type: z.string(), payload: z.record(z.unknown()).optional() })).optional(),
});
export type DialogueOption = z.infer<typeof DialogueOption>;

// --- Workflow (§7) ------------------------------------------------------------
export const Trigger = z.object({
  event: z.string().min(1),
  filter: z
    .object({
      random_chance: z.number().min(0).max(1).optional(),
    })
    .catchall(z.unknown())
    .optional(),
});

export const Action = z.record(z.unknown()); // verb -> args; validated per-verb by the registry

export const WorkflowState = z.object({
  actions: z.array(Action).default([]),
  guards: z.array(Guard).default([]),
  // event-keyed transitions: { "trade.completed": "next_state" }
  on: z.record(z.string(), z.string()).default({}),
  // timer transitions: { after: "10m", goto: "vanish" }
  timer: z.object({ after: Duration, goto: z.string() }).optional(),
  on_error: z
    .union([z.literal("abort"), z.string().regex(/^retry\(\d+\)$/), z.string()])
    .optional(),
  // Player-facing prompt (§5.4 dialogue as workflow): the bot line rendered on
  // entry, plus the option buttons whose clicks (a `dialogue.choose` event
  // carrying the option id) drive guarded, per-option transitions. Reuses the
  // DialogueOption shape so a haggle tree is authored as a workflow.
  prompt: z.string().optional(),
  options: z.array(DialogueOption).default([]),
  // Per-instance context writes (§7): on entering this state, each key is set to
  // the value its source expression resolves to (event.payload.x, event.actor.id,
  // event.correlationId, context.y, or a 'literal'). Later `guards` can branch on
  // context.* — the "remember data across states" a quest workflow needs.
  set: z.record(z.string(), z.string()).default({}),
  final: z.boolean().default(false),
});
export type WorkflowState = z.infer<typeof WorkflowState>;

export const Workflow = z.object({
  id: z.string().min(1),
  trigger: Trigger.optional(),
  scope: z.enum(["player", "npc", "world"]).default("world"),
  context: z.record(z.unknown()).default({}),
  // When true, a re-delivered trigger (e.g. bus replay on reboot) won't spawn a
  // duplicate while an instance for the same scope key is already active — for
  // perpetual/timer-loop workflows. Off by default: trigger-per-event workflows
  // (a per-build charge, a random appearance) want one instance per firing.
  singleton: z.boolean().default(false),
  initial: z.string().min(1),
  states: z.record(z.string(), WorkflowState),
});
export type Workflow = z.infer<typeof Workflow>;

// --- Schedule (§5.1 wander) ---------------------------------------------------
export const Schedule = z.object({
  id: z.string().min(1),
  min_dwell: Duration,
  stops: z.array(z.object({ guild_id: z.string(), channel: z.string() })).min(1),
});
export type Schedule = z.infer<typeof Schedule>;

// --- continents.yaml (§9) -----------------------------------------------------
export const Continents = z.object({
  continents: z.record(
    z.string(), // guild_id
    z.object({
      name: z.string().min(1),
      order: z.number().int().positive(),
      neighbors: z.array(z.string()).default([]),
      resource_bias: z.string().optional(),
      locale_flavor: z.string().optional(),
    }),
  ),
});
export type Continents = z.infer<typeof Continents>;

// --- districts.yaml (§2.2) — within-continent geography ----------------------
// Each continent (guild) holds a ring of districts (Discord categories). Logical
// ids resolve to `<id>_<guildId>` rows at world:init (like locations); `neighbors`
// name sibling logical ids. Exactly one district per continent should hold the
// bazaar — it's the public starting district (the others are hidden until found).
export const Districts = z.object({
  districts: z.record(
    z.string(), // guild_id
    z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        neighbors: z.array(z.string()).default([]),
        holds_bazaar: z.boolean().default(false),
      }),
    ),
  ),
});
export type Districts = z.infer<typeof Districts>;

// --- instances.yaml (§9) — dungeon pool, stubbed for iteration 1 -------------
export const Instances = z.object({
  dungeon_pool: z.array(z.string()).default([]),
});
export type Instances = z.infer<typeof Instances>;

// --- Event envelope (§6) ------------------------------------------------------
export const EventEnvelope = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  ts: z.string(),
  guild_id: z.string().optional(),
  actor: z.object({ kind: z.string(), id: z.string() }).optional(),
  subject: z.object({ kind: z.string(), id: z.string() }).optional(),
  payload: z.record(z.unknown()).default({}),
  correlation_id: z.string().optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
