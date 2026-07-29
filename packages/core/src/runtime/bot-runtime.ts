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
 * Config that can't be data — slash-command SQL resolvers, chatter trigger maps
 * — is passed in via `configs`, keyed by capability name.
 *
 * This is the ONLY place outside a capability that composes the process; it lives
 * in core because it wires core's own pieces (gateway, bus, capabilities).
 */
import { isAbsolute, join } from "node:path";
import { loadContentFile, Manifest, Shop, Schedule, Workflow, Continents, Riddles } from "@empire/content-schemas";
import { openDb } from "@empire/db";
import { rootLogger, type Logger } from "../logger.js";
import { CapabilityRegistry, type Capability, type CapabilityContext } from "./capability.js";
import { Gateway } from "../gateway/index.js";
import { EventBus } from "../events/bus.js";
import { PersonaResolver } from "./persona.js";
import { tradeCapability } from "../capabilities/trade.js";
import { topologyCapability } from "../capabilities/topology.js";
import { stallCapability } from "../capabilities/stall.js";
import { dialogueCapability } from "../capabilities/dialogue.js";
import { presenceVoiceCapability } from "../capabilities/presence-voice.js";
import { ambientChatterCapability, type ChatterConfig } from "../capabilities/ambient-chatter.js";
import { landCapability } from "../capabilities/land.js";
import { researchCapability } from "../capabilities/research.js";
import { notifyCapability } from "../capabilities/notify.js";
import { commandsCapability, type CommandDef } from "../capabilities/commands.js";
import { renderCapability } from "../capabilities/render.js";
import { travelCapability } from "../capabilities/travel.js";
import { wayfareCapability } from "../capabilities/wayfare.js";
import { gatekeeperCapability } from "../capabilities/gatekeeper.js";
import { marketCapability } from "../capabilities/market.js";
import { auctionCapability } from "../capabilities/auction.js";
import { combatCapability } from "../capabilities/combat.js";
import { caravanCapability } from "../capabilities/caravan.js";
import { riddleCapability } from "../capabilities/riddle.js";
import { worldMirrorCapability } from "../capabilities/world-mirror.js";
import { WorkflowRuntime } from "../workflow/runtime.js";

/** Code-provided capability config that can't live in YAML, keyed by capability name. */
export interface CapabilityConfigs {
  commands?: CommandDef[];
  "ambient.chatter"?: ChatterConfig;
}

/** The manifest `content` keys that name a single loadable file. */
type ContentKey = "shop" | "schedule" | "continents" | "riddles";

/**
 * Loads + validates one content file. Typed off `loadContentFile` itself so the
 * schema still drives the return type, without @empire/core taking a direct
 * dependency on zod just to name it.
 */
type ContentLoader = <S extends Parameters<typeof loadContentFile>[0]>(
  schema: S,
  rel: string,
) => ReturnType<typeof loadContentFile<S>>;

interface FactoryDeps {
  manifest: Manifest;
  configs: CapabilityConfigs;
  /** Load a manifest-declared content file, memoized for this bot. */
  load: ContentLoader;
}

/**
 * Load a content file the capability CANNOT work without; a manifest that names
 * the capability but not its content is a config bug, so it fails at boot.
 */
function required<S extends Parameters<typeof loadContentFile>[0]>(
  deps: FactoryDeps,
  schema: S,
  key: ContentKey,
  capName: string,
): ReturnType<typeof loadContentFile<S>> {
  const rel = deps.manifest.content?.[key];
  if (!rel) throw new Error(`capability "${capName}" needs content.${key} in manifest "${deps.manifest.id}"`);
  return deps.load(schema, rel);
}

/** Manifest capability name → factory. The registry of what a bot can be made of. */
const FACTORIES: Record<string, (deps: FactoryDeps) => Capability> = {
  trade: (deps) => {
    // A shop's prices are regional (§2.5), so a shop-backed trade also needs the
    // continent ring. Cost-sink bots (permits, loot grants) pass neither.
    const shop = deps.manifest.content?.shop;
    if (!shop) return tradeCapability();
    return tradeCapability(deps.load(Shop, shop), required(deps, Continents, "continents", "trade"));
  },
  topology: () => topologyCapability(),
  stall: (deps) => stallCapability(required(deps, Shop, "shop", "stall"), required(deps, Continents, "continents", "stall")),
  dialogue: () => dialogueCapability(),
  "presence.voice": (deps) => {
    const rel = deps.manifest.content?.schedule;
    const stops = rel ? deps.load(Schedule, rel).stops : [];
    return presenceVoiceCapability(stops.map((stop) => ({ guildId: stop.guild_id, channel: stop.channel })));
  },
  "ambient.chatter": (deps) => ambientChatterCapability(deps.configs["ambient.chatter"] ?? { reactions: {} }),
  land: () => landCapability(),
  research: () => researchCapability(),
  notify: () => notifyCapability(),
  commands: (deps) => commandsCapability(deps.configs.commands ?? []),
  render: () => renderCapability(),
  travel: (deps) => travelCapability(required(deps, Continents, "continents", "travel")),
  wayfare: (deps) => wayfareCapability(required(deps, Continents, "continents", "wayfare")),
  gatekeeper: (deps) => gatekeeperCapability(required(deps, Continents, "continents", "gatekeeper")),
  market: () => marketCapability(),
  auction: () => auctionCapability(),
  combat: () => combatCapability(),
  caravan: (deps) =>
    caravanCapability(required(deps, Shop, "shop", "caravan"), required(deps, Continents, "continents", "caravan")),
  riddle: (deps) => riddleCapability(required(deps, Riddles, "riddles", "riddle")),
  "world.mirror": () => worldMirrorCapability(),
};

/**
 * Read + validate a content file at most once per bot, keyed by resolved path.
 *
 * Several capabilities are configured from the SAME file — the herald's wayfare
 * and gatekeeper both take the continent ring, the merchant's trade and stall
 * both take the shop — and each load is a read plus env substitution plus a full
 * Zod parse. Loading once also means those capabilities share one object rather
 * than holding private copies of identical data.
 */
function memoizedLoader(contentDir: string): ContentLoader {
  const cache = new Map<string, unknown>();
  return (schema, rel) => {
    const path = join(contentDir, rel);
    if (!cache.has(path)) cache.set(path, loadContentFile(schema, path));
    return cache.get(path) as never;
  };
}

/**
 * Build the capabilities a manifest declares, in declared order (registration
 * order is dispatch order — keep render last so it draws the latest state).
 */
export function buildCapabilities(manifest: Manifest, configs: CapabilityConfigs, contentDir: string): Capability[] {
  const load = memoizedLoader(contentDir);
  return manifest.capabilities.map((name) => {
    const factory = FACTORIES[name];
    if (!factory) throw new Error(`unknown capability "${name}" in manifest "${manifest.id}"`);
    return factory({ manifest, configs, load });
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

  // Embedded workflow runtime (§7): declarative workflows the manifest lists run
  // in-process, so their action verbs dispatch through THIS bot's gateway/registry
  // (the standalone engine had no gateway and no-op'd). Timers are recovered from
  // persisted instances before the bus replays, so a reboot re-arms in-flight
  // workflows without the replayed trigger spawning a duplicate (singleton guard).
  const workflowPaths = manifest.content?.workflows ?? [];
  const runtime = workflowPaths.length
    ? new WorkflowRuntime(
        workflowPaths.map((rel) => loadContentFile(Workflow, join(contentDir, rel))),
        { sql, bus, registry, logger: log, makeContext },
      )
    : null;

  await gateway.login();
  await gateway.applyPersonas();
  for (const cap of registry.list()) await cap.init?.(makeContext(`boot_${manifest.id}`));
  await runtime?.recoverTimers();

  await bus.publish({ type: "bot.ready", subject: { kind: "npc", id: manifest.id } });

  // Bus boot sequence (subscribe → replay → drain de-duped) is inside subscribe().
  // The workflow runtime shares this single subscription (EventBus.subscribe is
  // one-shot); it advances after the capabilities so their state is settled first.
  await bus.subscribe(async (evt) => {
    const ctx = makeContext(evt.correlationId ?? evt.eventId);
    for (const cap of registry.matching(evt.type)) {
      await cap.handle?.(evt, ctx);
    }
    if (runtime) await runtime.onEvent(evt);
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
