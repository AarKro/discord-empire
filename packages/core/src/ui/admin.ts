/**
 * Ops/admin read views (framework spec §9 — the hidden Ops bot's observability
 * surface). Pure SQL→embed builders for the event log and live workflow
 * instances; the destructive `/admin-revert` path lives in @empire/db's
 * revertLedger. Kept in core (beside buildLeaderboardEmbed) so the bot-ops app
 * stays a thin command-def shell with no discord.js dependency of its own.
 */
import type { Sql } from "@empire/db";
import { EmbedBuilder } from "discord.js";

/** How many rows the admin views cap at (Discord embed-size hygiene). */
export const ADMIN_EVENTS_LIMIT = 15;
export const ADMIN_WORKFLOWS_LIMIT = 20;

interface EventRow {
  id: number;
  type: string;
  actor_kind: string | null;
  actor_id: string | null;
  correlation_id: string | null;
  ts: string;
}

/** Recent event-log rows, newest first, optionally filtered by type/correlation. */
export async function buildEventsEmbed(
  sql: Sql,
  opts: { type?: string | null; correlation?: string | null; limit?: number } = {},
): Promise<EmbedBuilder> {
  const limit = Math.min(Math.max(opts.limit ?? ADMIN_EVENTS_LIMIT, 1), 25);
  const type = opts.type ?? null;
  const correlation = opts.correlation ?? null;
  const rows = await sql<EventRow[]>`
    SELECT id, type, actor_kind, actor_id, correlation_id, ts
      FROM events
     WHERE (${type}::text IS NULL OR type = ${type})
       AND (${correlation}::text IS NULL OR correlation_id = ${correlation})
     ORDER BY id DESC
     LIMIT ${limit}
  `;
  const embed = new EmbedBuilder().setTitle("🗒️ Event log");
  const filters = [type ? `type=${type}` : null, correlation ? `corr=${correlation}` : null].filter(Boolean).join(" · ");
  if (rows.length === 0) {
    embed.setDescription(filters ? `No events match (${filters}).` : "No events yet.");
    return embed;
  }
  const lines = rows.map((r) => {
    const actor = r.actor_kind ? `${r.actor_kind}:${r.actor_id}` : "—";
    const corr = r.correlation_id ? ` \`${r.correlation_id}\`` : "";
    return `\`#${r.id}\` **${r.type}** · ${actor}${corr}`;
  });
  embed.setDescription(lines.join("\n"));
  embed.setFooter({ text: filters ? `${rows.length} shown · ${filters}` : `${rows.length} most recent` });
  return embed;
}

interface WorkflowRow {
  id: string;
  workflow_id: string;
  scope: string;
  scope_key: string;
  state: string;
  status: string;
  timer_at: string | null;
}

/** Live workflow instances, most-recently-updated first, optionally filtered. */
export async function buildWorkflowsEmbed(
  sql: Sql,
  opts: { scope?: string | null; status?: string | null } = {},
): Promise<EmbedBuilder> {
  const scope = opts.scope ?? null;
  const status = opts.status ?? null;
  const rows = await sql<WorkflowRow[]>`
    SELECT id, workflow_id, scope, scope_key, state, status, timer_at
      FROM workflow_instances
     WHERE (${scope}::text IS NULL OR scope = ${scope})
       AND (${status}::text IS NULL OR status = ${status})
     ORDER BY updated_at DESC
     LIMIT ${ADMIN_WORKFLOWS_LIMIT}
  `;
  const embed = new EmbedBuilder().setTitle("⚙️ Workflow instances");
  const filters = [scope ? `scope=${scope}` : null, status ? `status=${status}` : null].filter(Boolean).join(" · ");
  if (rows.length === 0) {
    embed.setDescription(filters ? `No instances match (${filters}).` : "No workflow instances.");
    return embed;
  }
  const lines = rows.map((r) => {
    const timer = r.timer_at ? ` ⏱${new Date(r.timer_at).toISOString().slice(11, 16)}` : "";
    return `\`${r.id}\` **${r.workflow_id}** [${r.scope}:${r.scope_key}] → \`${r.state}\` · ${r.status}${timer}`;
  });
  embed.setDescription(lines.join("\n"));
  embed.setFooter({ text: filters ? `${rows.length} shown · ${filters}` : `${rows.length} shown` });
  return embed;
}
