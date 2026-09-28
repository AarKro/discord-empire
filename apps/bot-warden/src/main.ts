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
import { join } from "node:path";
import {
  runBot,
  rootLogger,
  UNIT_TYPES,
  MUSTER_COST,
  MAX_MUSTER,
  MUSTER_PERMIT_ITEM,
  equipGear,
  unequipSlot,
  championSummary,
  type CommandDef,
} from "@empire/core";
import { loadContentFile, GearCatalog, type Gear } from "@empire/content-schemas";

/** Champion gear (§2.6) — the same file the warden's `trade` crafts from. */
const gearCatalog = loadContentFile(GearCatalog, join(process.env.CONTENT_DIR ?? "content", "catalog/gear.yaml"));

/** "2 iron tools + 20g" — a recipe's cost as the autocomplete shows it. */
function recipeCost(gear: Gear): string {
  const goods = Object.entries(gear.recipe.goods).map(([item, qty]) => `${qty} ${item.replace(/_/g, " ")}`);
  return [...goods, ...(gear.recipe.gold > 0 ? [`${gear.recipe.gold}g`] : [])].join(" + ");
}

// §5.10, §5.13. /muster, /dispatch and /craft are round-trips (guards →
// queue/send/craft → ephemeral reply); /army answers directly from the DB.
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
    autocomplete: async (ctx, typed, userId) => {
      const like = `%${typed.toLowerCase()}%`;
      const [player] = await ctx.sql<{ tier: number }[]>`SELECT tier FROM players WHERE discord_user_id = ${userId}`;
      const tier = player?.tier ?? 1;
      const rows = await ctx.sql<{ id: string; name: string; tier: number; unit_type: string }[]>`
        SELECT id, name, tier, unit_type FROM encounter_catalog
        WHERE lower(name) LIKE ${like} OR lower(id) LIKE ${like}
        ORDER BY tier ASC, id ASC
        LIMIT 25
      `;
      // The type is surfaced in the choice label on purpose: §2.6 puts the skill
      // in composition, which a player can only exercise if they can see what
      // they're marching against before they commit.
      // Above your tier is allowed — losing costs only the loot chance (§2.6) —
      // but flagged, so a gamble is a choice rather than a surprise.
      return rows.map((r) => ({
        name: `${r.name} — tier ${r.tier}, ${r.unit_type}${r.tier > tier ? " ⚠ beyond you" : ""}`,
        value: r.id,
      }));
    },
  },
  {
    // §2.6: gear is made, at your own finished forge, from goods and gold.
    name: "craft",
    description: "Forge a piece of champion gear",
    route: "craft.requested",
    options: [{ name: "gear", description: "What to make", autocomplete: true, required: true }],
    // Every recipe, with its cost and whether you can make it right now — the
    // `trade` capability re-checks all of it atomically when you commit.
    autocomplete: async (ctx, typed, userId) => {
      const built = new Set(
        (
          await ctx.sql<{ blueprint_id: string }[]>`
            SELECT DISTINCT blueprint_id FROM build_queue WHERE owner_id = ${userId} AND status = 'completed'
          `
        ).map((r) => r.blueprint_id),
      );
      const held = new Map(
        (
          await ctx.sql<{ item_id: string; qty: number }[]>`
            SELECT item_id, qty FROM inventories WHERE owner_kind = 'player' AND owner_id = ${userId}
          `
        ).map((r) => [r.item_id, r.qty]),
      );
      const [bal] = await ctx.sql<{ amount: number }[]>`
        SELECT amount FROM balances WHERE owner_kind = 'player' AND owner_id = ${userId} AND currency = 'gold'
      `;
      const needle = typed.toLowerCase();
      return gearCatalog.gear
        .filter((g) => g.name.toLowerCase().includes(needle) || g.item_id.includes(needle))
        .slice(0, 25)
        .map((g) => {
          const ready =
            built.has(g.recipe.requires) &&
            (bal?.amount ?? 0) >= g.recipe.gold &&
            Object.entries(g.recipe.goods).every(([item, qty]) => (held.get(item) ?? 0) >= qty);
          const mark = !built.has(g.recipe.requires) ? ` · needs a ${g.recipe.requires.replace(/_/g, " ")}` : ready ? " · ✓" : "";
          return { name: `${g.name} (${g.slot}) — ${recipeCost(g)}${mark}`.slice(0, 100), value: g.item_id };
        });
    },
  },
  {
    // §2.6: wear a piece of gear you hold. A choice, not custody — the gear
    // stays in your packs, and only what you still hold goes into a fight.
    name: "equip",
    description: "Put a piece of gear on your champion",
    route: "",
    options: [{ name: "gear", description: "What to wear", autocomplete: true, required: true }],
    autocomplete: async (ctx, typed, userId) => {
      const ids = gearCatalog.gear.map((g) => g.item_id);
      const held = await ctx.sql<{ item_id: string }[]>`
        SELECT item_id FROM inventories
        WHERE owner_kind = 'player' AND owner_id = ${userId} AND qty > 0 AND item_id = ANY(${ids})
      `;
      const needle = typed.toLowerCase();
      return held
        .map((r) => gearCatalog.gear.find((g) => g.item_id === r.item_id)!)
        .filter((g) => g.name.toLowerCase().includes(needle))
        .map((g) => ({ name: `${g.name} (${g.slot}) +${g.atk} atk +${g.def} def +${g.hp} hp`, value: g.item_id }));
    },
    resolve: async (ctx, { userId, options }) => equipGear(ctx.sql, userId, gearCatalog, String(options.gear ?? "")),
  },
  {
    name: "unequip",
    description: "Take a piece of gear off your champion",
    route: "",
    options: [{ name: "slot", description: "weapon, armor or trinket", autocomplete: true, required: true }],
    autocomplete: (_ctx, typed) =>
      Promise.resolve(["weapon", "armor", "trinket"].filter((s) => s.includes(typed.toLowerCase())).map((s) => ({ name: s, value: s }))),
    resolve: async (ctx, { userId, options }) => unequipSlot(ctx.sql, userId, String(options.slot ?? "")),
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

      // The champion's line carries its level, geared stats and loadout (§2.6).
      const champion = await championSummary(ctx.sql, userId, gearCatalog);
      const lines = units.filter((u) => u.kind !== "champion" || !champion).map((u) => {
        const what = u.kind === "champion" ? "Champion" : `${u.qty}× ${u.unit_type}`;
        const where = u.status === "dispatched" ? " _(afield)_" : u.status === "training" ? " _(drilling)_" : "";
        return `• ${what}${where}`;
      });

      if (champion) {
        const afieldChampion = units.some((u) => u.kind === "champion" && u.status === "dispatched");
        lines.unshift(champion + (afieldChampion ? " _(afield)_" : ""));
      }

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

runBot({
  manifest: "manifests/warden.yaml",
  // An empty muster permit sink would refuse every /muster realm-wide with an
  // out-of-stock message; `restock` keeps it topped (§5.12).
  configs: { commands, restock: { unlimitedItems: [MUSTER_PERMIT_ITEM] } },
}).catch((err) => {
  rootLogger.error({ err }, "warden crashed");
  process.exit(1);
});
