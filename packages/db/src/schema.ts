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
    // revertLedger probes `reason = 'revert:<id>'` for its idempotency marker;
    // without this that's a full scan of an append-only table on every revert.
    reasonIdx: index("ledger_reason_idx").on(t.reason),
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
  // { target: "land" | "dm", dm: boolean } — see notify capability (§5.9).
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
    // The originating workflow instance's correlation, threaded onto
    // research.completed so a concurrent research's completion routes back to the
    // right instance (§7) — mirrors build_queue.correlation_id.
    correlationId: text("correlation_id"),
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

// The research tree (§5, §4 Architect): the nodes /research offers. Cost is
// deducted through `trade`; base_ms is tier-scaled at enqueue (scaledResearchMs).
// prereqs gate availability (all must be 'done'); grants_blueprints are inserted
// into a player's `blueprints` on completion, unlocking them for /build. Mirrors
// blueprint_catalog; arrays are jsonb like districts.neighbors.
export const researchCatalog = pgTable("research_catalog", {
  id: text("id").primaryKey(), // e.g. "masonry", "trade_routes"
  name: text("name").notNull(), // display name, e.g. "Trade Routes"
  costGold: bigint("cost_gold", { mode: "number" }).notNull().default(0),
  baseMs: bigint("base_ms", { mode: "number" }).notNull().default(300000),
  prereqs: jsonb("prereqs").notNull().default([]), // research ids that must be done first
  grantsBlueprints: jsonb("grants_blueprints").notNull().default([]), // blueprint ids unlocked
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

// Per-continent (guild) membership roles (§9 gatekeeper): the "Citizen" role
// granted at a player's home continent and the "Observer" role granted at each
// continent they've discovered. Role ids are seeded by world-init.
export const continentRoles = pgTable("continent_roles", {
  guildId: text("guild_id").primaryKey(),
  citizenRoleId: text("citizen_role_id"),
  observerRoleId: text("observer_role_id"),
});

// Permanent continent discovery grants (§2.3, §9 gatekeeper): the continents a
// player watches as an Observer. Accumulative like `discoveries` — never shrinks.
// The player's home continent is `players.home_guild_id` (Citizen), not a row here.
export const continentDiscoveries = pgTable(
  "continent_discoveries",
  {
    playerId: text("player_id").notNull(),
    guildId: text("guild_id").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.playerId, t.guildId] }) }),
);

// Offers / orders / auctions — quotes with expiry (§5.5, §5.11).
export const offers = pgTable(
  "offers",
  {
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
    // §5.11 player market: the recipient of a `direct` offer, and the continent
    // (guild) a `order` stall listing renders on / the trade settles in.
    // For an `auction`: `price` is the current high bid (initialized to the
    // starting price / reserve), `taker_id` is the current high bidder (NULL until
    // the first qualifying bid), and `expires_at` is the close time.
    takerId: text("taker_id"),
    guildId: text("guild_id"),
  },
  (t) => ({
    // Every Marketplace / Auction House board refresh filters on exactly this
    // triple, and the tick service sweeps open auctions by expiry each minute.
    boardIdx: index("offers_board_idx").on(t.kind, t.status, t.guildId),
  }),
);

// Auction bids (§5.11): one row per bid placed. The bidder's gold is escrowed
// on insert (held under the auction Party `auction:<offer_id>`) and refunded on
// outbid; `won` marks the winning bid at close. The current high bid lives on
// the parent `offers` row — this table is the auditable bid history.
export const bids = pgTable(
  "bids",
  {
    id: text("id").primaryKey(), // bid_<ulid>
    offerId: text("offer_id").notNull(), // the auction (offers.id)
    bidderId: text("bidder_id").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(), // gold escrowed
    status: text("status").notNull().default("held"), // held | refunded | won
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byOfferStatus: index("bids_offer_status_idx").on(t.offerId, t.status) }),
);

// ---------------------------------------------------------------------------
// Combat & dispatch (§2.6, §5.13).
// ---------------------------------------------------------------------------

// A player's standing force: troop stacks and the single champion. This is also
// the SUBJECT of the dispatch primitive — a unit carries its own position, so
// "send someone" is expressible without a second concept (§5.13). PvE takes no
// losses (§2.6), so the cost of a mission is the unit being tied up in
// `dispatched` for the round trip, not attrition.
export const units = pgTable(
  "units",
  {
    id: text("id").primaryKey(), // unit_<ulid>
    ownerId: text("owner_id").notNull(),
    kind: text("kind").notNull().default("troop"), // troop | champion
    unitType: text("unit_type").notNull(), // infantry | cavalry | archer
    // Stack size. A champion is always qty 1 — it is the player's single hero.
    qty: integer("qty").notNull().default(1),
    atk: integer("atk").notNull().default(0),
    def: integer("def").notNull().default(0),
    hp: integer("hp").notNull().default(0),
    status: text("status").notNull().default("training"), // training | idle | dispatched
    // Muster timer. NULL while the charge is still in flight — the same
    // "pending across an async trade" carry that research.completes_at uses.
    readyAt: timestamp("ready_at", { withTimezone: true }),
    positionGuildId: text("position_guild_id"),
    positionDistrictId: text("position_district_id"),
    // The originating workflow instance's correlation, so concurrent musters
    // settle onto the right row (mirrors build_queue / research).
    correlationId: text("correlation_id"),
  },
  (t) => ({
    // Every muster guard and force assembly reads a player's roster by status.
    ownerStatusIdx: index("units_owner_status_idx").on(t.ownerId, t.status),
  }),
);

// The dispatch primitive (§5.13): a force with a position, a travel timer and a
// mission. Deliberately generic — `mission` is the discriminator, and the trade
// agents / caravans of §11 are meant to arrive as new mission kinds, not a new
// table. `force` snapshots what was actually sent, so the battle resolves
// against the force as dispatched even if the roster changes mid-flight.
export const dispatches = pgTable(
  "dispatches",
  {
    id: text("id").primaryKey(), // dsp_<ulid>
    ownerId: text("owner_id").notNull(),
    mission: jsonb("mission").notNull().default({}), // { kind: "battle", encounter_id }
    force: jsonb("force").notNull().default({}), // { champion, troops: [{ unit_id, unit_type, qty, atk, def, hp }] }
    originGuildId: text("origin_guild_id"),
    status: text("status").notNull().default("travelling"), // travelling | returning | done (| stationed for caravans)
    arrivesAt: timestamp("arrives_at", { withTimezone: true }),
    returnsAt: timestamp("returns_at", { withTimezone: true }),
    correlationId: text("correlation_id"),
  },
  (t) => ({
    // The tick sweeps both legs every minute: due arrivals, then due returns.
    dueIdx: index("dispatches_due_idx").on(t.status, t.arrivesAt),
  }),
);

// The resolution record (§5.13 "seeded & logged for auditability"). `seed` plus
// the force/encounter snapshot is enough to replay the fight exactly, so the
// stored `rounds` log can always be checked against a re-run.
export const battles = pgTable(
  "battles",
  {
    id: text("id").primaryKey(), // btl_<ulid>
    dispatchId: text("dispatch_id").notNull(),
    ownerId: text("owner_id").notNull(),
    encounterId: text("encounter_id").notNull(),
    seed: text("seed").notNull(),
    outcome: text("outcome").notNull(), // victory | defeat
    rounds: jsonb("rounds").notNull().default([]), // the replayable round log
    loot: jsonb("loot").notNull().default([]), // [{ item, qty }] actually awarded
    // The private thread the resolution log was delivered to (§2.6); NULL when
    // thread creation failed and the log fell back to the land channel.
    threadId: text("thread_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index("battles_owner_idx").on(t.ownerId),
    dispatchIdx: index("battles_dispatch_idx").on(t.dispatchId),
  }),
);

// The monster catalog (§2.6 world/monster events): what `/dispatch` can be sent
// against. Mirrors blueprint_catalog / research_catalog — a seeded DB table, not
// YAML, because it is data the command's autocomplete queries directly.
export const encounterCatalog = pgTable("encounter_catalog", {
  id: text("id").primaryKey(), // e.g. "moor_wolves"
  name: text("name").notNull(), // display name, e.g. "Moor Wolves"
  unitType: text("unit_type").notNull(), // its type, for the matchup triangle
  atk: integer("atk").notNull().default(0),
  def: integer("def").notNull().default(0),
  hp: integer("hp").notNull().default(0),
  tier: integer("tier").notNull().default(1),
  // One-way travel time; the return leg reuses it (§5.13 travel timer).
  travelMs: bigint("travel_ms", { mode: "number" }).notNull().default(300000),
  loot: jsonb("loot").notNull().default([]), // [{ item, qty, chance }] rolled on victory
  rewardGold: bigint("reward_gold", { mode: "number" }).notNull().default(0),
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
    // Every bot re-reads its own active instances on EVERY bus event, so this is
    // the hottest read in the system; the scope index can't serve it (it leads
    // with workflow_id but the predicate leads with status).
    activeIdx: index("wfi_active_idx").on(t.status, t.workflowId),
  }),
);
