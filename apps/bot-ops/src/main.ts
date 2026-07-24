/**
 * Ops — the hidden admin/observability bot (framework spec §9). It exposes the
 * event log, live workflow instances, and a ledger-revert god-tool as slash
 * commands, all gated to server Administrators via Discord
 * `default_member_permissions` so ordinary players never see them:
 *   /admin-events [type] [correlation] [limit]  — browse the event log
 *   /admin-workflows [scope] [status]           — inspect live instances
 *   /admin-revert <ledger_id>                   — undo a ledger transaction
 *
 * All three are DIRECT commands (read DB / mutate ledger → reply, no bus
 * round-trip). The generic runBot owns the lifecycle; the read views + the
 * revert live in @empire/core / @empire/db so this entrypoint stays a thin shell.
 */
import { runBot, rootLogger, buildEventsEmbed, buildWorkflowsEmbed, type CommandDef } from "@empire/core";
import { revertLedger } from "@empire/db";

/** Discord Administrator permission bit — gates the whole /admin-* surface (§9). */
const ADMIN = "8";

const commands: CommandDef[] = [
  {
    name: "admin-events",
    description: "Browse the event log (newest first)",
    route: "",
    defaultMemberPermissions: ADMIN,
    options: [
      { name: "type", description: "Filter by exact event type, e.g. trade.completed", required: false },
      { name: "correlation", description: "Filter by correlation id", required: false },
      { name: "limit", description: "How many to show (1–25, default 15)", required: false },
    ],
    resolve: async (ctx, { options }) => {
      const limit = options.limit ? Number.parseInt(options.limit, 10) : NaN;
      const embed = await buildEventsEmbed(ctx.sql, {
        type: options.type?.trim() || null,
        correlation: options.correlation?.trim() || null,
        ...(Number.isFinite(limit) ? { limit } : {}),
      });
      return { embeds: [embed.toJSON()] };
    },
  },
  {
    name: "admin-workflows",
    description: "Inspect live workflow instances",
    route: "",
    defaultMemberPermissions: ADMIN,
    options: [
      { name: "scope", description: "Filter by scope: player | npc | world", required: false },
      { name: "status", description: "Filter by status: active | final | failed", required: false },
    ],
    resolve: async (ctx, { options }) => {
      const embed = await buildWorkflowsEmbed(ctx.sql, {
        scope: options.scope?.trim() || null,
        status: options.status?.trim() || null,
      });
      return { embeds: [embed.toJSON()] };
    },
  },
  {
    name: "admin-revert",
    description: "Undo a ledger transaction by its id (god-mode; may go negative)",
    route: "",
    defaultMemberPermissions: ADMIN,
    options: [{ name: "ledger_id", description: "The ledger row id to revert", required: true }],
    resolve: async (ctx, { options, userId }) => {
      const id = options.ledger_id?.trim() ?? "";
      if (!/^\d+$/.test(id)) return "Provide a numeric ledger id (see `/admin-events`).";

      const res = await revertLedger(ctx.sql, { ledgerId: id });
      if (!res.ok) {
        return res.reason === "not_found"
          ? `No ledger row \`#${id}\`.`
          : `Ledger \`#${id}\` was already reverted.`;
      }

      // Audit + NOTIFY so any live observer reacts (persists the event too).
      await ctx.bus.publish({
        type: "ledger.reverted",
        actor: { kind: "admin", id: userId },
        payload: { ledger_id: id, compensating_id: res.compensatingId, ...res.summary },
      });

      const s = res.summary;
      const items = Object.entries(s.itemDeltas);
      const itemStr = items.length
        ? items.map(([k, v]) => `${v > 0 ? "+" : ""}${v}× ${k}`).join(", ")
        : "none";
      return (
        `Reverted ledger \`#${id}\` (${s.originalReason}). ` +
        `Undid **${s.currencyDelta > 0 ? "+" : ""}${s.currencyDelta} ${s.currency}** for ${s.actor} vs ${s.counterparty}; ` +
        `items: ${itemStr}. Compensating row \`#${res.compensatingId}\`.`
      );
    },
  },
];

runBot({ manifest: "manifests/ops.yaml", configs: { commands } }).catch((err) => {
  rootLogger.error({ err }, "ops crashed");
  process.exit(1);
});
