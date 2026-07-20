/**
 * land (framework spec §2.4, §5.12) — player holdings: channel provisioning,
 * private permissions, building THREADS, the build-queue UI, pruning/restore,
 * and the NPC-visit surface. Iteration-1 core: the full /build flow — guards
 * (registered player, valid blueprint, sufficient gold), cost deducted via the
 * `trade` capability, a build_queue row with a tier-scaled timer, and a result
 * event the commands capability turns into the ephemeral reply. The tick service
 * fires build.completed; we flip the row to 'completed' (guarded, so a redelivered
 * tick no-ops) and emit notify.requested for the player exactly once.
 *
 * Iteration-1 shortcut: the first /build auto-provisions a starter plot (the
 * auto-register-on-first-interaction philosophy, §2.1 — mirroring ensurePlayer)
 * and provisions its Discord surface: one text channel (the anchor for building
 * threads, later) and one voice channel (where NPCs gather) under the guild's
 * "Land" category. Provisioning needs Manage Channels; if the category or that
 * permission is absent the plot stays DB-only and notify's skip-with-log
 * fallback (§5.9) covers the missing channel — provisioning never blocks a build.
 *
 * Channel provisioning is exercised on dev servers; queue state and the
 * charge→enqueue handshake are the testable core.
 */
import { ulid } from "ulid";
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";
import { notForMe } from "../events.js";
import { locationChannel } from "../locations.js";
import { ensurePlayer, DEFAULT_STARTING_GOLD, type Sql } from "@empire/db";

/** Evict an awaiting-charge entry if its cost trade never settles (leak guard). */
const CHARGE_TIMEOUT_MS = 30_000;

/**
 * The single-use item a builder "sells" the player for a build. Modeling the
 * cost as a trade keeps the LEDGER write inside `trade` (invariant #2); the
 * atomic contract also gives us the "insufficient funds" guard for free.
 */
export const BUILD_PERMIT_ITEM = "build_permit";

/** Idle pacing is hybrid: higher tiers build slower (§2.5). */
export function scaledBuildMs(baseMs: number, tier: number): number {
  return Math.round(baseMs * (1 + 0.5 * (tier - 1)));
}

async function playerTier(sql: Sql, playerId: string): Promise<number> {
  const [p] = await sql<{ tier: number }[]>`SELECT tier FROM players WHERE discord_user_id = ${playerId}`;
  return p?.tier ?? 1;
}

interface BlueprintRow {
  id: string;
  name: string;
  cost_gold: number;
  base_ms: number;
}

async function loadBlueprint(sql: Sql, id: string): Promise<BlueprintRow | null> {
  const [row] = await sql<BlueprintRow[]>`
    SELECT id, name, cost_gold, base_ms FROM blueprint_catalog WHERE id = ${id}
  `;
  return row ?? null;
}

/**
 * Give a plot its Discord surface: a text + voice channel under the guild's
 * "Land" category (seeded by world:init as a `locations` row of kind 'land').
 * Best-effort — a missing category or Manage Channels permission logs and
 * leaves the plot DB-only rather than failing the build (§5.9 fallback).
 */
async function provisionPlotChannels(
  ctx: CapabilityContext,
  plotId: string,
  playerId: string,
  guildId: string,
): Promise<void> {
  const categoryId = await locationChannel(ctx.sql, guildId, "land");
  if (!categoryId) {
    ctx.logger.warn({ guildId }, "no land category for guild — run world:init; plot stays DB-only");
    return;
  }
  const channels = await ctx.gateway.createPlotChannels(guildId, playerId, categoryId);
  if (!channels) {
    ctx.logger.warn({ plotId, guildId }, "plot channel provisioning failed (needs Manage Channels)");
    return;
  }
  await ctx.sql`
    UPDATE land_plots
       SET text_channel_id = ${channels.textId}, voice_channel_id = ${channels.voiceId}
     WHERE id = ${plotId}
  `;
  ctx.logger.info({ plotId, ...channels }, "plot channels provisioned");
}

/**
 * Resolve the player's land plot, auto-provisioning a starter plot on first
 * /build (iteration-1 shortcut; see header). The deterministic id plus ON
 * CONFLICT DO NOTHING makes concurrent double-invocations safe — both callers
 * converge on the same row. A plot without Discord channels (freshly staked, or
 * staked before this permission was granted) gets them provisioned here.
 */
async function ensurePlot(ctx: CapabilityContext, playerId: string, guildId: string): Promise<string> {
  const [existing] = await ctx.sql<{ id: string; text_channel_id: string | null }[]>`
    SELECT id, text_channel_id FROM land_plots WHERE owner_id = ${playerId} AND pruned = false LIMIT 1
  `;
  const id = existing?.id ?? `plot_${playerId}`;
  if (!existing) {
    // A pruned plot shares this deterministic id but was filtered out above;
    // building reclaims it (un-prune) rather than leaving a stale pruned row.
    await ctx.sql`
      INSERT INTO land_plots (id, owner_id, guild_id)
      VALUES (${id}, ${playerId}, ${guildId})
      ON CONFLICT (id) DO UPDATE SET pruned = false
    `;
  }
  if (!existing?.text_channel_id) {
    await provisionPlotChannels(ctx, id, playerId, guildId);
  }
  return id;
}

export interface BuildStartArgs {
  player: string;
  plot: string;
  blueprint: string;
  base_ms: number;
}

export function landCapability(): Capability {
  /**
   * Builds awaiting their cost trade to settle, keyed by the trade's
   * correlationId. The commands capability's ephemeral reply shares the same
   * correlationId, so build.queued/build.rejected resolve it.
   */
  const awaitingCharge = new Map<
    string,
    { player: string; plot: string; blueprint: BlueprintRow; guildId: string | null; timer: ReturnType<typeof setTimeout> }
  >();

  /** Insert the build_queue row with a tier-scaled timer and announce it. */
  async function enqueueBuild(
    args: { player: string; plot: string; blueprint: BlueprintRow; guildId: string | null; correlationId: string | null },
    ctx: CapabilityContext,
  ): Promise<void> {
    const tier = await playerTier(ctx.sql, args.player);
    const durationMs = scaledBuildMs(args.blueprint.base_ms, tier);
    const completesAt = new Date(Date.now() + durationMs);
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO build_queue (owner_id, plot_id, blueprint_id, status, started_at, completes_at)
      VALUES (${args.player}, ${args.plot}, ${args.blueprint.id}, 'building', now(), ${completesAt})
      RETURNING id
    `;
    const mins = Math.max(1, Math.round(durationMs / 60000));
    ctx.logger.info({ player: args.player, blueprint: args.blueprint.id, durationMs }, "build queued");
    await ctx.bus.publish({
      type: "build.queued",
      guildId: args.guildId,
      actor: { kind: "player", id: args.player },
      subject: { kind: "npc", id: ctx.bot },
      payload: {
        queue_id: row!.id,
        blueprint: args.blueprint.id,
        completes_at: completesAt.toISOString(),
        message: `Foundation laid: **${args.blueprint.name}**, ready in ~${mins}m.`,
      },
      correlationId: args.correlationId,
    });
  }

  /** Publish an in-fiction rejection the commands capability turns into a reply. */
  async function reject(
    ctx: CapabilityContext,
    player: string,
    guildId: string | null,
    correlationId: string | null,
    message: string,
  ): Promise<void> {
    await ctx.bus.publish({
      type: "build.rejected",
      guildId,
      actor: { kind: "player", id: player },
      subject: { kind: "npc", id: ctx.bot },
      payload: { message },
      correlationId,
    });
  }

  /** /build entry: guards → trade.request (cost) → charge handshake. */
  async function requestBuild(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
    const player = evt.actor?.id;
    if (!player) return;
    const blueprintId = String((evt.payload as { blueprint?: unknown }).blueprint ?? "");
    const correlationId = evt.correlationId;
    const guildId = evt.guildId;

    // Guard: player registered (auto-register on first interaction, §2.1).
    const homeGuildId = ctx.personas.homeGuild(guildId);
    const { created } = await ensurePlayer(ctx.sql, player, homeGuildId, DEFAULT_STARTING_GOLD);
    if (created) ctx.logger.info({ player, startingGold: DEFAULT_STARTING_GOLD }, "player registered via /build");

    // Guard: valid blueprint.
    const blueprint = blueprintId ? await loadBlueprint(ctx.sql, blueprintId) : null;
    if (!blueprint) {
      await reject(ctx, player, guildId, correlationId, "No such blueprint in the ledgers, friend.");
      return;
    }

    // First build stakes a starter plot and provisions its channels.
    const plot = await ensurePlot(ctx, player, homeGuildId);

    // Deduct the cost through `trade` (invariant #2): a trade.request addressed
    // to this builder. The atomic trade is the authority on affordability — it
    // fails cleanly on insufficient funds, which we turn into the same rejection.
    // On trade.completed with this correlationId we enqueue; a trade that never
    // settles is evicted by a timer so awaitingCharge can't leak.
    const chargeCorr = correlationId ?? `bld_${ulid()}`;
    const timer = setTimeout(() => {
      if (awaitingCharge.delete(chargeCorr)) {
        ctx.logger.warn({ chargeCorr, player }, "build charge never settled; evicting");
        void reject(ctx, player, guildId, correlationId, "…the coin never cleared. Try again in a moment.");
      }
    }, CHARGE_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    awaitingCharge.set(chargeCorr, { player, plot, blueprint, guildId, timer });
    await ctx.bus.publish({
      type: "trade.request",
      guildId,
      actor: { kind: "player", id: player },
      subject: { kind: "npc", id: ctx.bot },
      payload: { item: BUILD_PERMIT_ITEM, qty: 1, price: blueprint.cost_gold },
      correlationId: chargeCorr,
    });
  }

  return {
    name: "land",
    consumes: ["build.requested", "build.completed", "trade.completed", "trade.failed"],
    actions: {
      /** Enqueue a build directly (workflow path); cost is deducted via trade. */
      "build.start": async (args, evt, ctx: CapabilityContext) => {
        const a = args as unknown as BuildStartArgs;
        const blueprint = await loadBlueprint(ctx.sql, a.blueprint);
        const bp: BlueprintRow = blueprint ?? {
          id: a.blueprint,
          name: a.blueprint,
          cost_gold: 0,
          base_ms: a.base_ms,
        };
        await enqueueBuild(
          { player: a.player, plot: a.plot, blueprint: bp, guildId: evt?.guildId ?? null, correlationId: evt?.correlationId ?? null },
          ctx,
        );
      },
    },

    async handle(evt, ctx) {
      // /build invocation → guards → trade round-trip.
      if (evt.type === "build.requested") {
        // Broadcast bus: only the addressed builder acts. A mismatch means a
        // mis-seeded/mis-addressed build — warn so it isn't a silent black hole.
        if (notForMe(evt, ctx.bot)) {
          ctx.logger.warn({ subject: evt.subject?.id, bot: ctx.bot }, "build.requested addressed to another bot; ignoring");
          return;
        }
        await requestBuild(evt, ctx);
        return;
      }

      // Cost trade settled: enqueue the build this bot is awaiting.
      if (evt.type === "trade.completed" || evt.type === "trade.failed") {
        const corr = evt.correlationId;
        if (!corr) return;
        const pending = awaitingCharge.get(corr);
        if (!pending) return; // not one of our build charges (broadcast bus).
        awaitingCharge.delete(corr);
        clearTimeout(pending.timer);
        if (evt.type === "trade.failed") {
          await reject(ctx, pending.player, pending.guildId, corr, "You can't cover the cost of that just yet.");
          return;
        }
        await enqueueBuild({ ...pending, correlationId: corr }, ctx);
        return;
      }

      // Tick service fires build.completed(queue_id). Flip the row to 'completed'
      // — guarded on status='building' so a redelivered tick returns no row and
      // no-ops — then ask notify to ping the player exactly once.
      if (evt.type === "build.completed") {
        const queueId = String((evt.payload as Record<string, unknown>).queue_id ?? "");
        if (!queueId) return;
        const [row] = await ctx.sql<{ owner_id: string; blueprint_id: string }[]>`
          UPDATE build_queue SET status = 'completed' WHERE id = ${queueId} AND status = 'building'
          RETURNING owner_id, blueprint_id
        `;
        if (!row) return;
        ctx.logger.info({ queueId, blueprint: row.blueprint_id }, "build completed");
        await ctx.bus.publish({
          type: "notify.requested",
          guildId: evt.guildId,
          actor: { kind: "player", id: row.owner_id },
          subject: { kind: "npc", id: ctx.bot },
          payload: { message: `Your ${row.blueprint_id} is complete!` },
        });
      }
    },
  };
}
