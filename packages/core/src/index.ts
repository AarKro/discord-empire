// Core infrastructure
export { rootLogger, withCorrelation } from "./logger.js";
export type { Logger } from "./logger.js";
export { EventBus, CHANNEL } from "./events/bus.js";
export type { BusEvent, PublishInput, EventHandler } from "./events/bus.js";
export { notForMe, payloadString } from "./events/helpers.js";
export { Backoff } from "./backoff.js";
export type { BackoffOptions } from "./backoff.js";
export { locationChannel, voiceStopChannel, landChannel } from "./world/locations.js";
export { playerTier, currentGuildId, tierScaledMs } from "./world/players.js";
export { publishReply, replyToCommand } from "./events/reply.js";
export type { ReplySource } from "./events/reply.js";
export { readNpcState, upsertNpcStateEntry, deleteNpcStateEntry, npcProximity } from "./world/npc-state.js";
export type { NpcProximity } from "./world/npc-state.js";
export { Gateway, toApplicationCommandJson } from "./gateway/index.js";
export type {
  GatewayOptions,
  ComponentInteraction,
  ComponentHandler,
  ModalSubmitInteraction,
  ModalSubmitHandler,
  ModalRequest,
  CommandInteraction,
  CommandHandler,
  AutocompleteInteraction,
  AutocompleteHandler,
  CommandRegistration,
} from "./gateway/index.js";
export { PersonaResolver } from "./runtime/persona.js";
export { ui, buttonRow, selectMenu, stallEmbed, marketOverviewEmbed, battleLogEmbed, modal } from "./ui/kit.js";
export {
  CapabilityRegistry,
} from "./runtime/capability.js";
export type { Capability, CapabilityContext, ActionHandler } from "./runtime/capability.js";

// Manifest-driven bot runner (§4 lifecycle)
export { runBot, buildCapabilities } from "./runtime/bot-runtime.js";
export { installCrashHandlers } from "./runtime/process.js";
export type { RunBotOptions, CapabilityConfigs } from "./runtime/bot-runtime.js";

// Combat resolution (§2.6, §5.13): pure, seeded, replayable — no DB, no Discord
export { resolveBattle, rollLoot, MAX_ROUNDS } from "./combat/resolve.js";
export type {
  Force,
  ForceTroop,
  ForceChampion,
  Encounter,
  RoundLog,
  BattleResult,
  ResolveInput,
  LootEntry,
} from "./combat/resolve.js";
export {
  UNIT_TYPES,
  isUnitType,
  matchupMultiplier,
  championStats,
  BASE_STATS,
  MUSTER_COST,
  ADVANTAGE,
  DISADVANTAGE,
} from "./combat/types.js";
export type { UnitType, StatBlock } from "./combat/types.js";

// Guard evaluation + player scope (unit-tested)
export { evalGuard, resolveSource, interpolate, loadGuardScope, DIALOGUE_OPTION_PREFIX } from "./dialogue/guards.js";
export type { GuardScope } from "./dialogue/guards.js";

// Cross-continent commerce guard (§2.3)
export {
  crossContinentCommerceBlock,
  tradeRoutesAndPostBlock,
  TRADE_ROUTES_RESEARCH,
  TRADE_POST_BLUEPRINT,
} from "./world/commerce.js";

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
export { ambientChatterCapability } from "./capabilities/ambient-chatter.js";
export type { ChatterConfig } from "./capabilities/ambient-chatter.js";
export { notifyCapability } from "./capabilities/notify.js";
export { commandsCapability } from "./capabilities/commands.js";
export type { CommandDef } from "./capabilities/commands.js";
export { landCapability, scaledBuildMs, buildableBlueprints } from "./capabilities/land.js";
export { progressionCapability, progressReport, eligibleTier, nextTier } from "./capabilities/progression.js";
export { accrued, msToNextUnit } from "./world/production.js";
export type { Production, Accrual } from "./world/production.js";
export { researchCapability, scaledResearchMs } from "./capabilities/research.js";
export { topologyCapability, requiresPresence } from "./capabilities/topology.js";
export type { PresenceCheck } from "./capabilities/topology.js";
export { travelCapability, startContinent, nextContinent } from "./capabilities/travel.js";
export { wayfareCapability } from "./capabilities/wayfare.js";
export { gatekeeperCapability, observerContinents, discoveredByArriving } from "./capabilities/gatekeeper.js";
export { marketCapability } from "./capabilities/market.js";
export { buildMarketOverviewEmbed } from "./capabilities/market-overview.js";
export { auctionCapability } from "./capabilities/auction.js";
export { worldMirrorCapability } from "./capabilities/world-mirror.js";
export {
  combatCapability,
  MUSTER_MS_PER_TROOP,
  MAX_MUSTER,
  BARRACKS_BLUEPRINT,
} from "./capabilities/combat.js";
export { caravanCapability, CARAVAN_MISSION, CARAVAN_TRAVEL_MS } from "./capabilities/caravan.js";

// The dispatch primitive's shared legs (§5.13), ridden by combat and caravan
export { returnDispatch, forceUnitIds } from "./world/dispatch.js";
export type { DispatchForceUnits } from "./world/dispatch.js";

// §2.5 local trade goods: per-continent commerce identity + the regional view
export { npcAt, isOwnNpc } from "./world/npc-identity.js";
export {
  regionOf,
  regionalItem,
  restockAmount,
  IMPORT_PRICE_MULTIPLIER,
  IMPORT_STOCK,
  UNLIMITED_STOCK,
  UNLIMITED_FLOOR,
} from "./world/goods.js";
export type { RegionalItem, RestockInput } from "./world/goods.js";
export { restockCapability, RESTOCK_INTERVAL_MS } from "./capabilities/restock.js";
export type { RestockConfig } from "./capabilities/restock.js";

// Internal (non-diegetic) item tokens — never show these in player-facing lists
export {
  HIDDEN_ITEMS,
  isHiddenItem,
  BUILD_PERMIT_ITEM,
  RESEARCH_PERMIT_ITEM,
  AUCTION_HOLD_ITEM,
  MUSTER_PERMIT_ITEM,
} from "./world/items.js";
export {
  buildLeaderboardEmbed,
  leaderboardRows,
  renownScore,
  BUILD_WEIGHT,
  RESEARCH_WEIGHT,
  LEADERBOARD_SIZE,
} from "./ui/leaderboard.js";
export { buildEventsEmbed, buildWorkflowsEmbed, ADMIN_EVENTS_LIMIT, ADMIN_WORKFLOWS_LIMIT } from "./ui/admin.js";
export { generateLine, isDialogueLlmEnabled } from "./dialogue/llm.js";
export type { GenerateLineOptions, MessagesClient } from "./dialogue/llm.js";
export { approachStranger, VISIT_WINDOW } from "./dialogue/stranger.js";
export type { ApproachDeps, StrangerPersona } from "./dialogue/stranger.js";
export { DEFAULT_MAX_PER_HOUR, maxPerHour, overHourlyCap } from "./dialogue/budget.js";
export { normalize, matchesAnswer, leaksAnswer, unusedHints, writeHint, judgeAnswer, pickRiddle, solvedFlag, dealtThisVisit, RIDDLE_VISIT_WINDOW } from "./dialogue/riddle.js";
export type { Riddle, HintResult, HintOptions, JudgeResult, JudgeOptions } from "./dialogue/riddle.js";
export { riddleCapability } from "./capabilities/riddle.js";
export type { RiddleBook } from "./capabilities/riddle.js";
