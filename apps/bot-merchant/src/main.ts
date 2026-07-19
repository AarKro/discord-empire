/**
 * Merchant — reference bot #1 (framework spec §4 roster, §10 validation path).
 *
 * Capabilities: presence.voice, stall, dialogue.thread, trade, voicelines,
 * ambient.chatter (+ topology for the presence gate). Stands in the Bazaar with
 * a stall embed; Enter-the-stall → private thread → scripted haggle against a
 * hidden, reputation-adjusted floor → atomic purchase (via `trade`) → receipt.
 *
 * Bot lifecycle (§4): load+validate manifest & content → login → apply personas
 * → join home VC self-muted → announce bot.ready → replay missed events (bus
 * boot sequence) → subscribe to capability event patterns.
 *
 * Invariants honored: this bot imports ONLY @empire/core (+ db types); it never
 * touches discord.js directly (all Discord goes through core), never imports
 * another bot, and only writes the ledger through core's `trade` capability.
 */
import { join } from "node:path";
import {
  loadContentFile,
  Manifest,
  Shop,
  Dialogue,
} from "@empire/content-schemas";
import {
  CapabilityRegistry,
  EventBus,
  Gateway,
  PersonaResolver,
  rootLogger,
  tradeCapability,
  stallCapability,
  dialogueThreadCapability,
  presenceVoiceCapability,
  voicelinesCapability,
  ambientChatterCapability,
  topologyCapability,
  renderCapability,
  type CapabilityContext,
} from "@empire/core";
import { openDb } from "@empire/db";

const CONTENT_DIR = process.env.CONTENT_DIR ?? "content";

async function main(): Promise<void> {
  const log = rootLogger.child({ bot: "merchant" });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const manifest = loadContentFile(Manifest, join(CONTENT_DIR, "manifests/merchant.yaml"));
  const shop = loadContentFile(Shop, join(CONTENT_DIR, manifest.content?.shop ?? "shops/aldric.yaml"));
  const dialogue = loadContentFile(Dialogue, join(CONTENT_DIR, manifest.content?.dialogue ?? "dialogue/aldric.yaml"));

  const token = process.env[manifest.token_env];
  if (!token) throw new Error(`${manifest.token_env} is required`);

  const { sql } = openDb(url);
  const personas = new PersonaResolver(manifest);
  const bus = new EventBus(sql, `bot-${manifest.id}`, log);
  const gateway = new Gateway({ token, botId: manifest.id, personas, logger: log });

  const registry = new CapabilityRegistry();
  // The shop supplies the hidden reputation-adjusted floor that `trade`
  // enforces on dialogue-emitted trade.request offers (§5.4/§5.5).
  registry.register(tradeCapability(shop));
  registry.register(topologyCapability());
  registry.register(stallCapability(shop));
  registry.register(dialogueThreadCapability(dialogue));
  registry.register(presenceVoiceCapability());
  registry.register(voicelinesCapability({ triggers: { "trade.completed": ["sale_1.opus"], "npc.arrived": ["greet_1.opus"] } }));
  registry.register(ambientChatterCapability({ reactions: { "world.rumor": ["Did you hear...?"] } }));
  // The one bus→Discord surface: renders stall embeds, dialogue threads, receipts.
  registry.register(renderCapability());

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

  // Bus boot sequence (subscribe → replay → drain de-duped) is inside subscribe().
  await bus.subscribe(async (evt) => {
    const ctx = makeContext(evt.correlationId ?? evt.eventId);
    for (const cap of registry.matching(evt.type)) {
      await cap.handle?.(evt, ctx);
    }
  });

  // Announce arrival at home per continent: the stall capability opens on
  // npc.arrived and the render capability draws the pinned embed (§4 lifecycle).
  for (const guildId of personas.guildIds) {
    await bus.publish({
      type: "npc.arrived",
      guildId,
      subject: { kind: "npc", id: manifest.id },
      payload: { channel: manifest.home?.[guildId]?.voice_channel ?? "bazaar_vc" },
    });
  }

  log.info({ capabilities: manifest.capabilities }, "merchant ready");
}

main().catch((err) => {
  rootLogger.error({ err }, "merchant crashed");
  process.exit(1);
});
