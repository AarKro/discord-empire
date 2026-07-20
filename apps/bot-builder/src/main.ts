/**
 * Builder — reference bot #2 (framework spec §4 roster, §10 validation path).
 *
 * Capabilities: commands, land, notify, trade (+ tick integration, +topology).
 * `/build` with blueprint autocomplete → cost & position guards → ledger
 * deduction (via `trade`) → per-player build-queue instance with a tier-scaled
 * timer; the tick service fires build.completed → building thread updated →
 * notification per player preference.
 *
 * Same invariants as the Merchant: imports only @empire/core (+ db types), no
 * direct discord.js, no cross-bot imports, ledger only through `trade`.
 */
import { join } from "node:path";
import { loadContentFile, Manifest } from "@empire/content-schemas";
import {
  CapabilityRegistry,
  EventBus,
  Gateway,
  PersonaResolver,
  rootLogger,
  tradeCapability,
  topologyCapability,
  landCapability,
  notifyCapability,
  commandsCapability,
  BUILD_PERMIT_ITEM,
  type CapabilityContext,
  type CommandDef,
} from "@empire/core";
import { openDb } from "@empire/db";

const CONTENT_DIR = process.env.CONTENT_DIR ?? "content";

async function main(): Promise<void> {
  const log = rootLogger.child({ bot: "builder" });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const manifest = loadContentFile(Manifest, join(CONTENT_DIR, "manifests/builder.yaml"));
  const token = process.env[manifest.token_env];
  if (!token) throw new Error(`${manifest.token_env} is required`);

  const { sql } = openDb(url);
  const personas = new PersonaResolver(manifest);
  const bus = new EventBus(sql, `bot-${manifest.id}`, log);
  const gateway = new Gateway({ token, botId: manifest.id, personas, logger: log });

  // Builder slash commands (§5.10, §10 Builder). /build is a round-trip (guards
  // → trade → queue → ephemeral reply); /balance and /inventory answer directly
  // from the DB. Autocomplete for blueprints is DB-backed, run inside core.
  const commands: CommandDef[] = [
    {
      name: "build",
      description: "Queue a building on your land",
      route: "build.requested",
      options: [{ name: "blueprint", description: "What to build", autocomplete: true, required: true }],
      autocomplete: async (ctx, typed) => {
        const like = `%${typed.toLowerCase()}%`;
        const rows = await ctx.sql<{ id: string; name: string; cost_gold: number }[]>`
          SELECT id, name, cost_gold FROM blueprint_catalog
          WHERE lower(name) LIKE ${like} OR lower(id) LIKE ${like}
          ORDER BY cost_gold ASC LIMIT 25
        `;
        return rows.map((r) => ({ name: `${r.name} (${r.cost_gold}g)`, value: r.id }));
      },
    },
    {
      name: "balance",
      description: "How much coin you carry",
      route: "",
      resolve: async (ctx, { userId }) => {
        const [bal] = await ctx.sql<{ amount: number }[]>`
          SELECT amount FROM balances
          WHERE owner_kind = 'player' AND owner_id = ${userId} AND currency = 'gold'
        `;
        return `You carry **${bal?.amount ?? 0} gold**.`;
      },
    },
    {
      name: "inventory",
      description: "What you own",
      route: "",
      resolve: async (ctx, { userId }) => {
        // build_permit is an internal cost-modeling token (the builder "sells" it
        // to charge for a build); it must never surface in the player's packs.
        const rows = await ctx.sql<{ item_id: string; qty: number }[]>`
          SELECT item_id, qty FROM inventories
          WHERE owner_kind = 'player' AND owner_id = ${userId} AND qty > 0 AND item_id <> ${BUILD_PERMIT_ITEM}
          ORDER BY item_id ASC
        `;
        if (rows.length === 0) return "Your packs are empty.";
        return "You carry:\n" + rows.map((r) => `• ${r.qty}× ${r.item_id}`).join("\n");
      },
    },
  ];

  const registry = new CapabilityRegistry();
  registry.register(tradeCapability());
  registry.register(topologyCapability());
  registry.register(landCapability());
  registry.register(notifyCapability());
  registry.register(commandsCapability(commands));

  const makeContext = (correlationId: string): CapabilityContext => ({
    bot: manifest.id,
    sql,
    bus,
    gateway,
    personas,
    logger: log.child({ correlation_id: correlationId }),
    config: (manifest.content ?? {}) as Record<string, unknown>,
  });

  await gateway.login();
  await gateway.applyPersonas();
  for (const cap of registry.list()) await cap.init?.(makeContext(`boot_${manifest.id}`));

  await bus.publish({ type: "bot.ready", subject: { kind: "npc", id: manifest.id } });

  await bus.subscribe(async (evt) => {
    const ctx = makeContext(evt.correlationId ?? evt.eventId);
    for (const cap of registry.matching(evt.type)) {
      await cap.handle?.(evt, ctx);
    }
  });

  log.info({ capabilities: manifest.capabilities }, "builder ready");
}

main().catch((err) => {
  rootLogger.error({ err }, "builder crashed");
  process.exit(1);
});
