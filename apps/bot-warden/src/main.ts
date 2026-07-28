/**
 * Warden — the combat & dispatch bot (framework spec §2.6, §5.13).
 *
 * Capabilities (see manifests/warden.yaml): trade, topology, combat, notify,
 * commands. `/muster` raises troops at a built barracks through the same
 * charge → timer → tick-completion shape as `/build`; `/dispatch` sends the
 * standing force and the champion against an encounter, and the seeded fight
 * resolves into a private-thread log on arrival.
 *
 * The generic runner (core's runBot) owns the lifecycle; this entrypoint only
 * supplies the manifest and the slash-command defs, whose autocomplete/resolve
 * bodies are live SQL and so are inherently code, not YAML.
 */
import { runBot, rootLogger, UNIT_TYPES, MUSTER_COST, MAX_MUSTER, type CommandDef } from "@empire/core";

// §5.10, §5.13. /muster and /dispatch are round-trips (guards → queue/send →
// ephemeral reply); /army answers directly from the DB.
const commands: CommandDef[] = [
  {
    name: "muster",
    description: "Raise troops at your barracks",
    route: "muster.requested",
    options: [
      { name: "type", description: "Which troops to drill", autocomplete: true, required: true },
      { name: "count", description: `How many (1-${MAX_MUSTER})`, required: true },
    ],
    autocomplete: (_ctx, typed) => {
      const like = typed.toLowerCase();
      return Promise.resolve(
        UNIT_TYPES.filter((t) => t.includes(like)).map((t) => ({
          name: `${t} (${MUSTER_COST[t]}g each)`,
          value: t,
        })),
      );
    },
  },
  {
    name: "dispatch",
    description: "Send your force against a foe",
    route: "dispatch.requested",
    options: [{ name: "encounter", description: "What to march on", autocomplete: true, required: true }],
    autocomplete: async (ctx, typed) => {
      const like = `%${typed.toLowerCase()}%`;
      const rows = await ctx.sql<{ id: string; name: string; tier: number; unit_type: string }[]>`
        SELECT id, name, tier, unit_type FROM encounter_catalog
        WHERE lower(name) LIKE ${like} OR lower(id) LIKE ${like}
        ORDER BY tier ASC, id ASC
        LIMIT 25
      `;
      // The type is surfaced in the choice label on purpose: §2.6 puts the skill
      // in composition, which a player can only exercise if they can see what
      // they're marching against before they commit.
      return rows.map((r) => ({ name: `${r.name} — tier ${r.tier}, ${r.unit_type}`, value: r.id }));
    },
  },
  {
    name: "army",
    description: "Your standing force and anything afield",
    route: "",
    resolve: async (ctx, { userId }) => {
      const units = await ctx.sql<{ kind: string; unit_type: string; qty: number; status: string }[]>`
        SELECT kind, unit_type, qty, status FROM units
        WHERE owner_id = ${userId} AND qty > 0
        ORDER BY kind DESC, unit_type ASC
      `;
      if (units.length === 0) return "You command no one yet. Build a barracks, then `/muster`.";

      const lines = units.map((u) => {
        const what = u.kind === "champion" ? "Champion" : `${u.qty}× ${u.unit_type}`;
        const where = u.status === "dispatched" ? " _(afield)_" : u.status === "training" ? " _(drilling)_" : "";
        return `• ${what}${where}`;
      });

      const afield = await ctx.sql<{ encounter: string; status: string }[]>`
        SELECT mission->>'encounter_id' AS encounter, status FROM dispatches
        WHERE owner_id = ${userId} AND status <> 'done'
        ORDER BY arrives_at ASC
      `;
      if (afield.length > 0) {
        lines.push(
          "",
          ...afield.map((d) =>
            d.status === "returning"
              ? `⚔️ Returning from **${d.encounter}**`
              : `⚔️ Marching on **${d.encounter}**`,
          ),
        );
      }
      return lines.join("\n");
    },
  },
];

runBot({ manifest: "manifests/warden.yaml", configs: { commands } }).catch((err) => {
  rootLogger.error({ err }, "warden crashed");
  process.exit(1);
});
