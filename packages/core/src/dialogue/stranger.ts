/**
 * The hooded stranger's `/approach` interaction (framework spec §5.4 / §11 —
 * "Secret Merchant first"). A player who approaches the travelling Secret
 * Merchant while it's on their continent gets ONE cryptic, LLM-worded line.
 *
 * Three independent cost gates, so players can't run up an API bill:
 *   1. PRESENCE — the stranger must be on the player's continent (gameplay).
 *   2. ONCE PER VISIT — a player gets one line per appearance (a rolling window
 *      keyed on the `dialogue.approached` event log; matches the dwell time).
 *   3. GLOBAL CIRCUIT BREAKER — a hard hourly ceiling on real API calls,
 *      counted from the `dialogue.generated` event log.
 * Both gates are plain COUNT queries over the events table — no new table, no
 * migration, and auditable via the Ops bot's /admin-events.
 *
 * The model supplies wording only; a fixed pool of authored lines is the
 * fallback for every failure path (no key, timeout, refusal, over-cap), so the
 * feature degrades to atmospheric-but-static and never blocks the game.
 */
import type { Sql } from "@empire/db";
import type { EventBus } from "../events/bus.js";
import type { Logger } from "../logger.js";
import { readNpcState } from "../world/npc-state.js";
import { generateLine, isDialogueLlmEnabled, type MessagesClient } from "./llm.js";
import { maxPerHour, overHourlyCap } from "./budget.js";

/** Once-per-visit window — a player gets one line per appearance. Tuned to the
 *  Secret Merchant's dwell (see workflows/secret_merchant.yaml). */
export const VISIT_WINDOW = "45 minutes";

/** Authored fallback lines — the stranger's voice when the model is unavailable. */
const FALLBACK_LINES = [
  "The tides remember what the shore forgets. Mind which you trust.",
  "Coin is a poor compass, traveller — yet here you are, following it.",
  "I have walked where your maps end. There is less there than you'd hope, and more than you'd fear.",
  "Buy low, they say. I say: know what you are truly paying.",
  "A door opens on the far continent. Whether it opens for you… that I cannot say.",
  "Keep your blade dull and your ledger sharp, and you may yet see me again.",
];

function pickFallback(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return FALLBACK_LINES[Math.abs(h) % FALLBACK_LINES.length]!;
}

function strangerSystem(localeFlavor: string | undefined): string {
  const locale = localeFlavor ? ` The scene is a ${localeFlavor} setting.` : "";
  return (
    "You are a mysterious hooded stranger in a fantasy trading world — a rare, itinerant figure who speaks in riddles." +
    locale +
    " A traveller has approached you. Reply with ONE short, cryptic, atmospheric line (1–2 sentences), in character." +
    " Do NOT mention prices, concrete offers, item names, numbers, or game mechanics. No preamble, no quotation marks, no stage directions."
  );
}

export interface ApproachDeps {
  sql: Sql;
  bus: EventBus;
  logger: Logger;
  /** The Secret Merchant's bot/npc id (ctx.bot). */
  npcId: string;
}

export interface StrangerPersona {
  nickname: string;
  localeFlavor?: string | undefined;
}

/**
 * Resolve a player's `/approach`: run the gates, generate-or-fall-back, record
 * the interaction, and return the ephemeral reply text. `client` is injectable
 * for tests. Emits `dialogue.generated` ONLY on a real API call (cost
 * accounting) and `dialogue.approached` whenever a line is delivered (the visit
 * is spent either way).
 */
export async function approachStranger(
  deps: ApproachDeps,
  userId: string,
  persona: StrangerPersona,
  client?: MessagesClient,
): Promise<string> {
  const { sql, bus, logger, npcId } = deps;

  // 1) PRESENCE — where is the stranger standing right now?
  const state = await readNpcState<{ guild?: string | null }>(sql, npcId);
  const here = state.guild ?? null;
  if (!here) return "You search the shadows, but no stranger stirs here. Perhaps on another shore.";

  const [pos] = await sql<{ position_guild_id: string | null }[]>`
    SELECT position_guild_id FROM players WHERE discord_user_id = ${userId}
  `;
  if ((pos?.position_guild_id ?? null) !== here) return "You sense no such presence nearby.";

  // 2) ONCE PER VISIT — has this player already been given a line this appearance?
  // Bound by VISIT_WINDOW itself (bound as text, cast server-side) so the window
  // can't drift away from the exported constant the way a literal did.
  const [seen] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM events
     WHERE type = 'dialogue.approached' AND actor_id = ${userId} AND guild_id = ${here}
       AND ts > now() - ${VISIT_WINDOW}::interval
  `;
  if ((seen?.n ?? 0) > 0) {
    return "The stranger meets your eyes and says nothing more — their words for you are already spoken.";
  }

  // 3) GLOBAL CIRCUIT BREAKER — a hard hourly ceiling on real generations,
  // shared with every other LLM dialogue feature (see dialogue/budget.ts).
  const overCap = await overHourlyCap(sql);

  let line: string;
  let generated = false;
  if (!overCap && (client || isDialogueLlmEnabled())) {
    try {
      line = await generateLine(
        { system: strangerSystem(persona.localeFlavor), user: `A traveller approaches the ${persona.nickname}. What do you say to them?` },
        client,
      );
      generated = true;
    } catch (err) {
      logger.warn({ err, npc: npcId }, "stranger line generation failed — using authored fallback");
      line = pickFallback(`${userId}:${here}`);
    }
  } else {
    if (overCap) logger.info({ maxPerHour: maxPerHour() }, "dialogue circuit breaker tripped — using authored fallback");
    line = pickFallback(`${userId}:${here}`);
  }

  // Record: cost only on a real call; the visit is spent either way.
  if (generated) {
    await bus.publish({
      type: "dialogue.generated",
      guildId: here,
      actor: { kind: "player", id: userId },
      subject: { kind: "npc", id: npcId },
      payload: { npc: npcId },
    });
  }
  await bus.publish({
    type: "dialogue.approached",
    guildId: here,
    actor: { kind: "player", id: userId },
    subject: { kind: "npc", id: npcId },
    payload: { generated },
  });

  return `*The hooded stranger leans close.* ${line}`;
}
