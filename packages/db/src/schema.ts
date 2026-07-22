/**
 * Drizzle schema for Discord Empire.
 *
 * Design invariants (framework spec §5.5, §8):
 *   - The ledger is append-only. Balances and inventories are DERIVED from it.
 *   - The event log has a monotonic bigserial id; it is the replay source.
 *   - Only the `trade` capability (in @empire/core) ever writes ledger rows.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Event log — the monotonic, append-only record and replay source (§3, §6).
// ---------------------------------------------------------------------------
export const events = pgTable(
  "events",
  {
    // Monotonic id used for replay & de-dup ("last processed id" per bot).
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    // Public event id from the envelope (evt_...); stable across replay.
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    guildId: text("guild_id"),
    actorKind: text("actor_kind"),
    actorId: text("actor_id"),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    payload: jsonb("payload").notNull().default({}),
    correlationId: text("correlation_id"),
  },
  (t) => ({
    eventIdUq: uniqueIndex("events_event_id_uq").on(t.eventId),
    typeIdx: index("events_type_idx").on(t.type),
    corrIdx: index("events_correlation_idx").on(t.correlationId),
  }),
);

// ---------------------------------------------------------------------------
// Ledger — append-only economic transactions (§8). Every mutation is a row.
// ---------------------------------------------------------------------------
export const ledger = pgTable(
  "ledger",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    actorKind: text("actor_kind").notNull(), // player | npc | market | auction | world
    actorId: text("actor_id").notNull(),
    counterpartyKind: text("counterparty_kind").notNull(),
    counterpartyId: text("counterparty_id").notNull(),
    currency: text("currency").notNull().default("gold"),
    // Signed currency delta applied to the actor (counterparty gets the inverse).
    currencyDelta: bigint("currency_delta", { mode: "number" }).notNull(),
    // Item deltas applied to the actor: { item_id: signedQty, ... }.
    itemDeltas: jsonb("item_deltas").notNull().default({}),
    reason: text("reason").notNull(), // npc_trade | p2p_trade | market_fill | auction | build_cost | research_cost
    causeEventId: bigint("cause_event_id", { mode: "bigint" }),
  },
  (t) => ({
    actorIdx: index("ledger_actor_idx").on(t.actorKind, t.actorId),
    causeIdx: index("ledger_cause_idx").on(t.causeEventId),
  }),
);

// ---------------------------------------------------------------------------
// Per-bot cursor: last-processed event id for lossless replay (§3).
// ---------------------------------------------------------------------------
export const busCursors = pgTable("bus_cursors", {
  consumer: text("consumer").primaryKey(), // e.g. "bot-merchant"
  lastProcessedId: bigint("last_processed_id", { mode: "bigint" }).notNull().default(sql`0`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Core game state (§8).
// ---------------------------------------------------------------------------
export const players = pgTable("players", {
  discordUserId: text("discord_user_id").primaryKey(),
  homeGuildId: text("home_guild_id").notNull(),
  // Position is pure DB state (§2.3); Discord only reflects it.
  positionGuildId: text("position_guild_id"),
  positionDistrictId: text("position_district_id"),
  tier: integer("tier").notNull().default(1),
  // { channel: "land" | "dm", dm: boolean } — see notify capability (§5.9).
  notificationPrefs: jsonb("notification_prefs").notNull().default({ target: "land", dm: false }),
  flags: jsonb("flags").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Wallet & inventory are derived caches over the ledger for query speed;
// the ledger remains authoritative and reconciliation is possible any time.
export const balances = pgTable(
  "balances",
  {
    ownerKind: text("owner_kind").notNull(),
    ownerId: text("owner_id").notNull(),
    currency: text("currency").notNull().default("gold"),
    amount: bigint("amount", { mode: "number" }).notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerKind, t.ownerId, t.currency] }) }),
);

export const inventories = pgTable(
  "inventories",
  {
    ownerKind: text("owner_kind").notNull(),
    ownerId: text("owner_id").notNull(),
    itemId: text("item_id").notNull(),
    qty: bigint("qty", { mode: "number" }).notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerKind, t.ownerId, t.itemId] }) }),
);

export const npcs = pgTable("npcs", {
  id: text("id").primaryKey(), // logical character token, e.g. "merchant"
  kind: text("kind").notNull().default("merchant"),
  state: jsonb("state").notNull().default({}),
});

export const locations = pgTable("locations", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id"),
  districtId: text("district_id"),
  kind: text("kind").notNull(), // bazaar | tavern | landmark | transit | land
  requiresPresence: boolean("requires_presence").notNull().default(true),
});

export const districts = pgTable("districts", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  name: text("name").notNull(),
  categoryId: text("category_id"),
  viewRoleId: text("view_role_id"),
  neighbors: jsonb("neighbors").notNull().default([]), // ring edges (district ids)
});

export const landPlots = pgTable("land_plots", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  guildId: text("guild_id").notNull(),
  districtId: text("district_id"),
  voiceChannelId: text("voice_channel_id"),
  textChannelId: text("text_channel_id"),
  pruned: boolean("pruned").notNull().default(false),
});

export const buildQueue = pgTable(
  "build_queue",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ownerId: text("owner_id").notNull(),
    plotId: text("plot_id").notNull(),
    blueprintId: text("blueprint_id").notNull(),
    threadId: text("thread_id"),
    status: text("status").notNull().default("queued"), // queued | building | completed | cancelled
    // The originating workflow instance's correlation, threaded onto build.completed
    // so a concurrent build's completion routes back to the right instance (§7).
    correlationId: text("correlation_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completesAt: timestamp("completes_at", { withTimezone: true }),
  },
  (t) => ({ ownerIdx: index("build_queue_owner_idx").on(t.ownerId) }),
);

export const research = pgTable(
  "research",
  {
    ownerId: text("owner_id").notNull(),
    researchId: text("research_id").notNull(),
    status: text("status").notNull().default("locked"), // locked | in_progress | done
    completesAt: timestamp("completes_at", { withTimezone: true }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.researchId] }) }),
);

export const blueprints = pgTable(
  "blueprints",
  {
    ownerId: text("owner_id").notNull(),
    blueprintId: text("blueprint_id").notNull(),
    source: text("source").notNull().default("research"), // research | found
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.blueprintId] }) }),
);

// The buildable catalog (§5.12, §10 Builder): the recipes /build offers. Cost is
// deducted through `trade`; base_ms is tier-scaled at enqueue (scaledBuildMs).
// Distinct from `blueprints`, which records which recipes a PLAYER owns.
export const blueprintCatalog = pgTable("blueprint_catalog", {
  id: text("id").primaryKey(), // e.g. "farm", "forge"
  name: text("name").notNull(), // display name, e.g. "Wheat Farm"
  costGold: bigint("cost_gold", { mode: "number" }).notNull().default(0),
  baseMs: bigint("base_ms", { mode: "number" }).notNull().default(300000),
});

export const reputation = pgTable(
  "reputation",
  {
    playerId: text("player_id").notNull(),
    npcId: text("npc_id").notNull(),
    score: integer("score").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.playerId, t.npcId] }) }),
);

// Co-presence contacts (§2.3): symmetric edges stored once (a < b).
export const contacts = pgTable(
  "contacts",
  {
    playerA: text("player_a").notNull(),
    playerB: text("player_b").notNull(),
    metAt: timestamp("met_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.playerA, t.playerB] }) }),
);

// Permanent district discovery grants (§2.2) — the map never shrinks.
export const discoveries = pgTable(
  "discoveries",
  {
    playerId: text("player_id").notNull(),
    districtId: text("district_id").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.playerId, t.districtId] }) }),
);

// Offers / orders / auctions — quotes with expiry (§5.5, §5.11).
export const offers = pgTable("offers", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // direct | order | auction
  makerKind: text("maker_kind").notNull(),
  makerId: text("maker_id").notNull(),
  itemId: text("item_id").notNull(),
  qty: integer("qty").notNull(),
  price: bigint("price", { mode: "number" }).notNull(),
  side: text("side").notNull().default("sell"), // buy | sell
  status: text("status").notNull().default("open"), // open | filled | expired | cancelled
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

// Persisted workflow instances (§7): survive restarts.
export const workflowInstances = pgTable(
  "workflow_instances",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    scope: text("scope").notNull(), // player | npc | world
    scopeKey: text("scope_key").notNull(), // player id / npc id / "world"
    state: text("state").notNull(),
    context: jsonb("context").notNull().default({}),
    correlationId: text("correlation_id"),
    // Wall-clock deadline for the current state's timer, if any.
    timerAt: timestamp("timer_at", { withTimezone: true }),
    status: text("status").notNull().default("active"), // active | final | failed
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: index("wfi_scope_idx").on(t.workflowId, t.scope, t.scopeKey),
    timerIdx: index("wfi_timer_idx").on(t.timerAt),
  }),
);
