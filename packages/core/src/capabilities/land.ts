/**
 * land (framework spec §2.4, §5.12) — player holdings: channel provisioning,
 * private permissions, building THREADS, the build-queue UI, pruning/restore,
 * and the NPC-visit surface. Iteration-1 core: the /build flow.
 *
 * The flow is now a declarative workflow (§7, content/workflows/player_build.yaml)
 * that composes the verbs this capability exports — the imperative handle() glue
 * has been replaced. The verbs are the primitive steps: build.request (guards +
 * stake plot + charge via `trade`), build.enqueue (charge settled → queue with a
 * tier-scaled timer), build.complete (tick's build.completed → finish, notify),
 * and build.reject (charge failed → clean up + in-fiction reply). A pending build
 * is carried across the async charge as a build_queue row in status 'queued'
 * (blueprint + plot known, completes_at null), keyed by the workflow instance's
 * correlation. A player may have several builds in flight: each event (the charge's
 * trade.completed, the tick's build.completed) carries that correlation, so the
 * runtime routes it to the right instance and the verbs act on the matching row.
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
import type { Capability, CapabilityContext } from "../capability.js";
import { locationChannel } from "../locations.js";
import { ensurePlayer, DEFAULT_STARTING_GOLD, type Sql } from "@empire/db";

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
  const [row] = await sql<{ tier: number }[]>`SELECT tier FROM players WHERE discord_user_id = ${playerId}`;
  return row?.tier ?? 1;
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

export function landCapability(): Capability {
  /** Publish an in-fiction rejection the commands capability turns into a reply. */
  async function publishRejection(
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

  return {
    name: "land",
    // Nothing imperative to consume — the player_build workflow (§7) drives the
    // flow by composing the verbs below; the runtime dispatches them.
    consumes: [],
    actions: {
      /**
       * /build entry: guards → stake plot → charge via `trade`. Records the
       * pending build as a 'queued' build_queue row keyed by the instance's
       * correlation (the carry across the async charge; concurrent builds each get
       * their own row) and emits trade.request. On an unknown blueprint it emits
       * the rejection itself and THROWS so the workflow's on_error routes to its
       * final cleanup state.
       */
      "build.request": async (_args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        const blueprintId = String((evt?.payload as { blueprint?: unknown } | undefined)?.blueprint ?? "");
        const correlationId = evt?.correlationId ?? null;
        const guildId = evt?.guildId ?? null;

        // Guard: player registered (auto-register on first interaction, §2.1).
        const homeGuildId = ctx.personas.homeGuild(guildId);
        const { created } = await ensurePlayer(ctx.sql, player, homeGuildId, DEFAULT_STARTING_GOLD);
        if (created) ctx.logger.info({ player, startingGold: DEFAULT_STARTING_GOLD }, "player registered via /build");

        // Guard: valid blueprint.
        const blueprint = blueprintId ? await loadBlueprint(ctx.sql, blueprintId) : null;
        if (!blueprint) {
          await publishRejection(ctx, player, guildId, correlationId, "No such blueprint in the ledgers, friend.");
          throw new Error("invalid blueprint");
        }

        // First build stakes a starter plot and provisions its channels.
        const plot = await ensurePlot(ctx, player, homeGuildId);

        // Record the pending build (correlation-keyed so build.enqueue/reject find
        // THIS build among a player's concurrent ones once the charge settles;
        // completes_at null = not yet building). Then deduct the cost through
        // `trade` (invariant #2): a trade.request addressed to this builder. The
        // atomic trade is the authority on affordability — it fails cleanly on
        // insufficient funds, which trade.failed → build.reject turns into a
        // rejection. correlationId threads to the ephemeral reply too.
        await ctx.sql`
          INSERT INTO build_queue (owner_id, plot_id, blueprint_id, status, correlation_id)
          VALUES (${player}, ${plot}, ${blueprint.id}, 'queued', ${correlationId})
        `;
        await ctx.bus.publish({
          type: "trade.request",
          guildId,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: { item: BUILD_PERMIT_ITEM, qty: 1, price: blueprint.cost_gold },
          correlationId,
        });
      },

      /** Charge settled: promote this build's 'queued' row to a timed 'building' and announce it. */
      "build.enqueue": async (_args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        const correlationId = evt?.correlationId ?? null;
        if (!player) return;
        const [pending] = await ctx.sql<{ id: string; plot_id: string; blueprint_id: string }[]>`
          SELECT id, plot_id, blueprint_id FROM build_queue
          WHERE owner_id = ${player} AND correlation_id = ${correlationId} AND status = 'queued'
          ORDER BY id DESC LIMIT 1
        `;
        if (!pending) {
          ctx.logger.warn({ player, correlationId }, "build.enqueue: no queued build for this charge");
          return;
        }
        const blueprint = await loadBlueprint(ctx.sql, pending.blueprint_id);
        const tier = await playerTier(ctx.sql, player);
        const durationMs = scaledBuildMs(blueprint?.base_ms ?? 0, tier);
        const completesAt = new Date(Date.now() + durationMs);
        await ctx.sql`
          UPDATE build_queue SET status = 'building', started_at = now(), completes_at = ${completesAt.toISOString()}
          WHERE id = ${pending.id}
        `;
        const mins = Math.max(1, Math.round(durationMs / 60000));
        ctx.logger.info({ player, blueprint: pending.blueprint_id, durationMs }, "build queued");
        await ctx.bus.publish({
          type: "build.queued",
          guildId: evt?.guildId ?? null,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: {
            queue_id: pending.id,
            blueprint: pending.blueprint_id,
            completes_at: completesAt.toISOString(),
            message: `Foundation laid: **${blueprint?.name ?? pending.blueprint_id}**, ready in ~${mins}m.`,
          },
          correlationId: evt?.correlationId ?? null,
        });
      },

      /**
       * Tick's build.completed(queue_id): flip the row to 'completed' — guarded on
       * status='building' so a redelivered tick returns no row and no-ops — then
       * ask notify to ping the player exactly once.
       */
      "build.complete": async (_args, evt, ctx: CapabilityContext) => {
        const queueId = String((evt?.payload as Record<string, unknown> | undefined)?.queue_id ?? "");
        if (!queueId) return;
        const [row] = await ctx.sql<{ owner_id: string; blueprint_id: string }[]>`
          UPDATE build_queue SET status = 'completed' WHERE id = ${queueId} AND status = 'building'
          RETURNING owner_id, blueprint_id
        `;
        if (!row) return;
        ctx.logger.info({ queueId, blueprint: row.blueprint_id }, "build completed");
        await ctx.bus.publish({
          type: "notify.requested",
          guildId: evt?.guildId ?? null,
          actor: { kind: "player", id: row.owner_id },
          subject: { kind: "npc", id: ctx.bot },
          payload: { message: `Your ${row.blueprint_id} is complete!` },
        });
      },

      /**
       * Charge failed or timed out: discard this build's pending 'queued' row and
       * reply in-fiction. Keyed by correlation so it drops only the affected build
       * (concurrent ones untouched); on the timeout path the runtime's synthetic
       * timer event supplies the instance's player + correlation.
       */
      "build.reject": async (args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        const correlationId = evt?.correlationId ?? null;
        const message = String((args as { message?: unknown }).message ?? "That build fell through, friend.");
        if (player) {
          await ctx.sql`DELETE FROM build_queue WHERE owner_id = ${player} AND correlation_id = ${correlationId} AND status = 'queued'`;
        }
        await publishRejection(ctx, player ?? "", evt?.guildId ?? null, correlationId, message);
      },
    },
  };
}
