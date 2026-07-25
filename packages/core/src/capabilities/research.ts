/**
 * research (framework spec §4 Architect, §5, §2.3) — the Architect's research
 * tree: timed, gold-costed unlocks that gate progression and grant blueprints.
 *
 * Structurally a clone of the build queue (`land` capability). The flow is a
 * declarative workflow (§7, content/workflows/architect_research.yaml) composing
 * the verbs here: research.request (guards prereqs + charge via `trade`),
 * research.enqueue (charge settled → time the node), research.complete (tick's
 * research.completed → finish, grant blueprints, notify), research.reject (charge
 * failed → clean up + in-fiction reply).
 *
 * A node is one `research` row per (player, node) — you research each node once.
 * The pending state across the async charge is status 'in_progress' with
 * completes_at NULL (charge not yet cleared); enqueue sets completes_at, which is
 * what the tick fires on. A player may research several DIFFERENT nodes at once —
 * each row carries the originating workflow instance's correlation, so the runtime
 * routes each event (the charge's trade.completed, the tick's research.completed)
 * back to the right instance and the verbs act on the matching row.
 */
import type { Capability, CapabilityContext } from "../runtime/capability.js";
import { payloadString } from "../events/helpers.js";
import { playerTier, tierScaledMs } from "../world/players.js";
import { publishReply } from "../events/reply.js";
import { RESEARCH_PERMIT_ITEM } from "../world/items.js";
import { ensurePlayer, DEFAULT_STARTING_GOLD, type Sql } from "@empire/db";

/** Research pacing (§2.5). Named re-export of the shared curve — see tierScaledMs. */
export const scaledResearchMs = tierScaledMs;

interface ResearchNodeRow {
  id: string;
  name: string;
  cost_gold: number;
  base_ms: number;
  prereqs: string[];
  grants_blueprints: string[];
}

async function loadNode(sql: Sql, id: string): Promise<ResearchNodeRow | null> {
  const [row] = await sql<ResearchNodeRow[]>`
    SELECT id, name, cost_gold, base_ms, prereqs, grants_blueprints
    FROM research_catalog WHERE id = ${id}
  `;
  return row ?? null;
}

/** Node ids a player has already completed — the set every prereq must be in. */
async function doneResearch(sql: Sql, playerId: string): Promise<Set<string>> {
  const rows = await sql<{ research_id: string }[]>`
    SELECT research_id FROM research WHERE owner_id = ${playerId} AND status = 'done'
  `;
  return new Set(rows.map((r) => r.research_id));
}

export function researchCapability(): Capability {
  return {
    name: "research",
    // Nothing imperative to consume — the architect_research workflow (§7) drives
    // the flow by composing the verbs below; the runtime dispatches them.
    consumes: [],
    actions: {
      /**
       * /research entry: guards (registered, valid node, not already owned/underway,
       * prereqs met) → charge via `trade`. Records the pending node as an
       * 'in_progress' row with completes_at NULL (the carry across the async charge),
       * keyed by the instance's correlation, then emits trade.request. On a guard
       * failure it emits the rejection itself and THROWS so the workflow's on_error
       * routes to its final cleanup state.
       */
      "research.request": async (_args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        const nodeId = payloadString(evt, "node");
        const correlationId = evt?.correlationId ?? null;
        const guildId = evt?.guildId ?? null;

        // Guard: player registered (auto-register on first interaction, §2.1).
        const homeGuildId = ctx.personas.homeGuild(guildId);
        const { created } = await ensurePlayer(ctx.sql, player, homeGuildId, DEFAULT_STARTING_GOLD);
        if (created) ctx.logger.info({ player, startingGold: DEFAULT_STARTING_GOLD }, "player registered via /research");

        // Guard: valid node.
        const node = nodeId ? await loadNode(ctx.sql, nodeId) : null;
        if (!node) {
          await publishReply(ctx, "research.rejected", { guildId, correlationId }, player, "No such research in the archives, friend.");
          throw new Error("invalid research node");
        }

        // Guard: not already completed or underway (idempotent re-request).
        const [existing] = await ctx.sql<{ status: string }[]>`
          SELECT status FROM research WHERE owner_id = ${player} AND research_id = ${node.id}
        `;
        if (existing?.status === "done") {
          await publishReply(ctx, "research.rejected", { guildId, correlationId }, player, `You've already mastered **${node.name}**.`);
          throw new Error("research already done");
        }
        if (existing?.status === "in_progress") {
          await publishReply(ctx, "research.rejected", { guildId, correlationId }, player, `**${node.name}** is already underway.`);
          throw new Error("research already in progress");
        }

        // Guard: prereqs met — every prerequisite node must be 'done'.
        const done = await doneResearch(ctx.sql, player);
        const missing = node.prereqs.filter((p) => !done.has(p));
        if (missing.length > 0) {
          await publishReply(
            ctx,
            "research.rejected",
            { guildId, correlationId },
            player,
            `**${node.name}** needs more groundwork first: ${missing.join(", ")}.`,
          );
          throw new Error("research prereqs unmet");
        }

        // Record the pending node (correlation-keyed so enqueue/reject find THIS
        // attempt once the charge settles; completes_at NULL = not yet timed). Then
        // deduct the cost through `trade` (invariant #2): a trade.request addressed
        // to this Architect. The atomic trade is the authority on affordability — it
        // fails cleanly on insufficient funds, which trade.failed → research.reject
        // turns into a rejection. correlationId threads to the ephemeral reply too.
        await ctx.sql`
          INSERT INTO research (owner_id, research_id, status, correlation_id, completes_at)
          VALUES (${player}, ${node.id}, 'in_progress', ${correlationId}, NULL)
          ON CONFLICT (owner_id, research_id)
          DO UPDATE SET status = 'in_progress', correlation_id = ${correlationId}, completes_at = NULL
        `;
        await ctx.bus.publish({
          type: "trade.request",
          guildId,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: { item: RESEARCH_PERMIT_ITEM, qty: 1, price: node.cost_gold },
          correlationId,
        });
      },

      /** Charge settled: give this node's pending row a tier-scaled timer and announce it. */
      "research.enqueue": async (_args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        const correlationId = evt?.correlationId ?? null;
        if (!player) return;
        const [pending] = await ctx.sql<{ research_id: string }[]>`
          SELECT research_id FROM research
          WHERE owner_id = ${player} AND correlation_id = ${correlationId}
            AND status = 'in_progress' AND completes_at IS NULL
          LIMIT 1
        `;
        if (!pending) {
          ctx.logger.warn({ player, correlationId }, "research.enqueue: no pending node for this charge");
          return;
        }
        const node = await loadNode(ctx.sql, pending.research_id);
        const tier = await playerTier(ctx.sql, player);
        const durationMs = scaledResearchMs(node?.base_ms ?? 0, tier);
        const completesAt = new Date(Date.now() + durationMs);
        await ctx.sql`
          UPDATE research SET completes_at = ${completesAt.toISOString()}
          WHERE owner_id = ${player} AND research_id = ${pending.research_id}
        `;
        const mins = Math.max(1, Math.round(durationMs / 60000));
        ctx.logger.info({ player, node: pending.research_id, durationMs }, "research started");
        await ctx.bus.publish({
          type: "research.queued",
          guildId: evt?.guildId ?? null,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: {
            node: pending.research_id,
            completes_at: completesAt.toISOString(),
            message: `Research begun: **${node?.name ?? pending.research_id}**, ready in ~${mins}m.`,
          },
          correlationId,
        });
      },

      /**
       * Tick's research.completed(node): flip the row to 'done' — guarded on
       * status='in_progress' so a redelivered tick returns no row and no-ops — then
       * grant every blueprint the node unlocks and ping the player once.
       */
      "research.complete": async (_args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        const nodeId = payloadString(evt, "node");
        if (!player || !nodeId) return;
        const [row] = await ctx.sql<{ research_id: string }[]>`
          UPDATE research SET status = 'done', completes_at = now()
          WHERE owner_id = ${player} AND research_id = ${nodeId} AND status = 'in_progress'
          RETURNING research_id
        `;
        if (!row) return;
        const node = await loadNode(ctx.sql, nodeId);
        // Grant the unlocked blueprints into the player's ownership (source='research').
        for (const blueprintId of node?.grants_blueprints ?? []) {
          await ctx.sql`
            INSERT INTO blueprints (owner_id, blueprint_id, source)
            VALUES (${player}, ${blueprintId}, 'research')
            ON CONFLICT (owner_id, blueprint_id) DO NOTHING
          `;
        }
        ctx.logger.info(
          { player, node: nodeId, granted: node?.grants_blueprints ?? [] },
          "research completed",
        );
        await ctx.bus.publish({
          type: "notify.requested",
          guildId: evt?.guildId ?? null,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: { message: `Research complete: ${node?.name ?? nodeId}!` },
        });
      },

      /**
       * Charge failed or timed out: discard this node's pending row and reply
       * in-fiction. Keyed by correlation so it drops only the affected attempt
       * (concurrent research untouched); on the timeout path the runtime's synthetic
       * timer event supplies the instance's player + correlation.
       */
      "research.reject": async (args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        const correlationId = evt?.correlationId ?? null;
        const message = String((args as { message?: unknown }).message ?? "That research fell through, friend.");
        if (player) {
          await ctx.sql`
            DELETE FROM research
            WHERE owner_id = ${player} AND correlation_id = ${correlationId}
              AND status = 'in_progress' AND completes_at IS NULL
          `;
        }
        await publishReply(ctx, "research.rejected", evt, player ?? "", message);
      },
    },
  };
}
