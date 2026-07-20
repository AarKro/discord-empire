/**
 * Generic, manifest-driven bot runner (§4 lifecycle). A bot is a manifest plus a
 * little code-only config: the runner loads+validates the manifest, builds the
 * capabilities its `capabilities:` list names (wiring their YAML content from the
 * manifest's `content` block), then runs the standard lifecycle — login → apply
 * personas → init → announce bot.ready → subscribe → announce arrival (if the bot
 * has a home). Adding a bot that reuses existing capabilities is now a manifest +
 * a two-line entrypoint; only genuinely new mechanics need new capability code.
 *
 * Content-shaped config (shop, dialogue tree, wander schedule) comes from YAML.
 * Config that can't be data — slash-command SQL resolvers, voiceline/chatter
 * trigger maps — is passed in via `configs`, keyed by capability name.
 *
 * This is the ONLY place outside a capability that composes the process; it lives
 * in core because it wires core's own pieces (gateway, bus, capabilities).
 */
import { isAbsolute, join } from "node:path";
import { loadContentFile, Manifest, Shop, Dialogue, Schedule } from "@empire/content-schemas";
import { openDb } from "@empire/db";
import { rootLogger, type Logger } from "./logger.js";
import { CapabilityRegistry, type Capability, type CapabilityContext } from "./capability.js";
import { Gateway } from "./gateway.js";
import { EventBus } from "./bus.js";
import { PersonaResolver } from "./persona.js";
import { tradeCapability } from "./capabilities/trade.js";
import { topologyCapability } from "./capabilities/topology.js";
import { stallCapability } from "./capabilities/stall.js";
import { dialogueThreadCapability } from "./capabilities/dialogue-thread.js";
import { presenceVoiceCapability } from "./capabilities/presence-voice.js";
import { voicelinesCapability, type VoicelineConfig } from "./capabilities/voicelines.js";
import { ambientChatterCapability, type ChatterConfig } from "./capabilities/ambient-chatter.js";
import { landCapability } from "./capabilities/land.js";
import { notifyCapability } from "./capabilities/notify.js";
import { commandsCapability, type CommandDef } from "./capabilities/commands.js";
import { renderCapability } from "./capabilities/render.js";

/** Code-provided capability config that can't live in YAML, keyed by capability name. */
export interface CapabilityConfigs {
  commands?: CommandDef[];
  voicelines?: VoicelineConfig;
  "ambient.chatter"?: ChatterConfig;
}

interface FactoryDeps {
  manifest: Manifest;
  contentDir: string;
  configs: CapabilityConfigs;
}

/** Resolve a manifest content path against the content dir; throw if the cap needs it. */
function content(deps: FactoryDeps, key: "shop" | "dialogue" | "schedule", capName: string): string {
  const rel = deps.manifest.content?.[key];
  if (!rel) throw new Error(`capability "${capName}" needs content.${key} in manifest "${deps.manifest.id}"`);
  return join(deps.contentDir, rel);
}

/** Manifest capability name → factory. The registry of what a bot can be made of. */
const FACTORIES: Record<string, (deps: FactoryDeps) => Capability> = {
  trade: (deps) => tradeCapability(deps.manifest.content?.shop ? loadContentFile(Shop, join(deps.contentDir, deps.manifest.content.shop)) : undefined),
  topology: () => topologyCapability(),
  stall: (deps) => stallCapability(loadContentFile(Shop, content(deps, "shop", "stall"))),
  "dialogue.thread": (deps) => dialogueThreadCapability(loadContentFile(Dialogue, content(deps, "dialogue", "dialogue.thread"))),
  "presence.voice": (deps) => {
    const rel = deps.manifest.content?.schedule;
    const stops = rel ? loadContentFile(Schedule, join(deps.contentDir, rel)).stops : [];
    return presenceVoiceCapability(stops.map((stop) => ({ guildId: stop.guild_id, channel: stop.channel })));
  },
  voicelines: (deps) => voicelinesCapability(deps.configs.voicelines ?? { triggers: {} }),
  "ambient.chatter": (deps) => ambientChatterCapability(deps.configs["ambient.chatter"] ?? { reactions: {} }),
  land: () => landCapability(),
  notify: () => notifyCapability(),
  commands: (deps) => commandsCapability(deps.configs.commands ?? []),
  render: () => renderCapability(),
};

/**
 * Build the capabilities a manifest declares, in declared order (registration
 * order is dispatch order — keep render last so it draws the latest state).
 */
export function buildCapabilities(manifest: Manifest, configs: CapabilityConfigs, contentDir: string): Capability[] {
  return manifest.capabilities.map((name) => {
    const factory = FACTORIES[name];
    if (!factory) throw new Error(`unknown capability "${name}" in manifest "${manifest.id}"`);
    return factory({ manifest, contentDir, configs });
  });
}

export interface RunBotOptions {
  /** Manifest path, absolute or relative to the content dir. */
  manifest: string;
  /** Content root; defaults to $CONTENT_DIR or "content". */
  contentDir?: string;
  /** Code-only capability config (SQL resolvers, trigger maps) keyed by capability name. */
  configs?: CapabilityConfigs;
  logger?: Logger;
}

/** Load a manifest and run its bot through the standard lifecycle (§4). */
export async function runBot(opts: RunBotOptions): Promise<void> {
  const contentDir = opts.contentDir ?? process.env.CONTENT_DIR ?? "content";
  const manifestPath = isAbsolute(opts.manifest) ? opts.manifest : join(contentDir, opts.manifest);
  const manifest = loadContentFile(Manifest, manifestPath);
  const log = (opts.logger ?? rootLogger).child({ bot: manifest.id });

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const token = process.env[manifest.token_env];
  if (!token) throw new Error(`${manifest.token_env} is required`);

  const { sql } = openDb(url);
  const personas = new PersonaResolver(manifest);
  const bus = new EventBus(sql, `bot-${manifest.id}`, log);
  const gateway = new Gateway({ token, botId: manifest.id, personas, logger: log });

  const registry = new CapabilityRegistry();
  for (const cap of buildCapabilities(manifest, opts.configs ?? {}, contentDir)) registry.register(cap);

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

  // A bot with a home announces arrival per guild (§4): the stall opens and the
  // render capability draws the pinned embed.
  if (manifest.home) {
    for (const guildId of personas.guildIds) {
      await bus.publish({
        type: "npc.arrived",
        guildId,
        subject: { kind: "npc", id: manifest.id },
        payload: { channel: manifest.home[guildId]?.voice_channel ?? "" },
      });
    }
  }

  log.info({ capabilities: manifest.capabilities }, `${manifest.id} ready`);
}
