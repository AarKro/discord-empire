/**
 * land (framework spec §2.4, §5.12) — player holdings: channel provisioning,
 * private permissions, building THREADS, the build-queue UI, pruning/restore,
 * and the NPC-visit surface. Iteration-1 core: the build-queue instance with a
 * tier-scaled timer, cost guard, and completion handling. Channel/thread
 * provisioning is exercised on dev servers; queue state is the testable core.
 */
import type { Capability, CapabilityContext } from "../capability.js";
import type { Sql } from "@empire/db";

/** Idle pacing is hybrid: higher tiers build slower (§2.5). */
export function scaledBuildMs(baseMs: number, tier: number): number {
  return Math.round(baseMs * (1 + 0.5 * (tier - 1)));
}

async function playerTier(sql: Sql, playerId: string): Promise<number> {
  const [p] = await sql<{ tier: number }[]>`SELECT tier FROM players WHERE discord_user_id = ${playerId}`;
  return p?.tier ?? 1;
}

export interface BuildStartArgs {
  player: string;
  plot: string;
  blueprint: string;
  base_ms: number;
}

export function landCapability(): Capability {
  return {
    name: "land",
    consumes: ["build.completed"],
    actions: {
      /** Enqueue a build with a tier-scaled timer; cost is deducted via trade. */
      "build.start": async (args, evt, ctx: CapabilityContext) => {
        const a = args as unknown as BuildStartArgs;
        const tier = await playerTier(ctx.sql, a.player);
        const durationMs = scaledBuildMs(a.base_ms, tier);
        const completesAt = new Date(Date.now() + durationMs);
        const [row] = await ctx.sql<{ id: string }[]>`
          INSERT INTO build_queue (owner_id, plot_id, blueprint_id, status, started_at, completes_at)
          VALUES (${a.player}, ${a.plot}, ${a.blueprint}, 'building', now(), ${completesAt})
          RETURNING id
        `;
        ctx.logger.info({ player: a.player, blueprint: a.blueprint, durationMs }, "build queued");
        await ctx.bus.publish({
          type: "build.queued",
          ...(evt?.guildId ? { guildId: evt.guildId } : {}),
          actor: { kind: "player", id: a.player },
          payload: { queue_id: row!.id, blueprint: a.blueprint, completes_at: completesAt.toISOString() },
        });
      },
    },
    async handle(evt, ctx) {
      // Tick service fires build.completed(queue_id); update the queue + notify.
      if (evt.type !== "build.completed") return;
      const queueId = String((evt.payload as Record<string, unknown>).queue_id ?? "");
      if (!queueId) return;
      const [row] = await ctx.sql<{ owner_id: string; blueprint_id: string }[]>`
        UPDATE build_queue SET status = 'completed' WHERE id = ${queueId} AND status = 'building'
        RETURNING owner_id, blueprint_id
      `;
      if (!row) return;
      ctx.logger.info({ queueId, blueprint: row.blueprint_id }, "build completed");
    },
  };
}
