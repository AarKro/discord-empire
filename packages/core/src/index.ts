// Core infrastructure
export { rootLogger, withCorrelation } from "./logger.js";
export type { Logger } from "./logger.js";
export { EventBus, CHANNEL } from "./bus.js";
export type { BusEvent, PublishInput, EventHandler } from "./bus.js";
export { notForMe } from "./events.js";
export { locationChannel } from "./locations.js";
export { Gateway, toApplicationCommandJson } from "./gateway.js";
export type {
  GatewayOptions,
  ComponentInteraction,
  ComponentHandler,
  CommandInteraction,
  CommandHandler,
  AutocompleteInteraction,
  AutocompleteHandler,
  CommandRegistration,
} from "./gateway.js";
export { PersonaResolver } from "./persona.js";
export { ui, buttonRow, selectMenu, stallEmbed, modal } from "./ui-kit.js";
export {
  CapabilityRegistry,
} from "./capability.js";
export type { Capability, CapabilityContext, ActionHandler } from "./capability.js";

// Manifest-driven bot runner (§4 lifecycle)
export { runBot, buildCapabilities } from "./bot-runtime.js";
export type { RunBotOptions, CapabilityConfigs } from "./bot-runtime.js";

// Dev-world bootstrap (world:init)
export { bootstrapWorld, DEFAULT_BLUEPRINTS } from "./bootstrap.js";
export type { BootstrapOptions, BlueprintSeed } from "./bootstrap.js";

// Guard evaluation + player scope (unit-tested)
export { evalGuard, loadGuardScope, DIALOGUE_OPTION_PREFIX } from "./dialogue.js";
export type { GuardScope } from "./dialogue.js";

// Workflow engine (§7): pure transition core + embedded runtime
export { decide, entry, guardsPass, parseOnError, scopeMatches } from "./workflow/engine.js";
export type { Stimulus, TransitionDecision } from "./workflow/engine.js";
export { WorkflowRuntime } from "./workflow/runtime.js";
export type { RuntimeDeps } from "./workflow/runtime.js";
export { parseDuration } from "./workflow/duration.js";

// Capability modules (Merchant + Builder scope, plus cross-cutting topology)
export { tradeCapability, effectiveFloor } from "./capabilities/trade.js";
export type { QuoteInput } from "./capabilities/trade.js";
export { stallCapability, ENTER_STALL_BUTTON } from "./capabilities/stall.js";
export { renderCapability } from "./capabilities/render.js";
export { dialogueCapability } from "./capabilities/dialogue.js";
export { presenceVoiceCapability } from "./capabilities/presence-voice.js";
export type { WanderStop } from "./capabilities/presence-voice.js";
export { voicelinesCapability } from "./capabilities/voicelines.js";
export type { VoicelineConfig } from "./capabilities/voicelines.js";
export { ambientChatterCapability } from "./capabilities/ambient-chatter.js";
export type { ChatterConfig } from "./capabilities/ambient-chatter.js";
export { notifyCapability } from "./capabilities/notify.js";
export { commandsCapability } from "./capabilities/commands.js";
export type { CommandDef } from "./capabilities/commands.js";
export { landCapability, scaledBuildMs, BUILD_PERMIT_ITEM } from "./capabilities/land.js";
export { topologyCapability, requiresPresence } from "./capabilities/topology.js";
export type { PresenceCheck } from "./capabilities/topology.js";
