/**
 * progression (framework spec §2.5) — a player's tier rises on milestones.
 *
 * `players.tier` drives the idle pacing (build, research and muster times grow
 * with it) and IS the champion's level, but nothing used to write it: every
 * player was tier 1 forever. Tiers are content (content/tiers.yaml): cumulative
 * counts of finished buildings, finished research and battles won.
 *
 * Checked whenever one of those counts can have moved — build.finished,
 * research.finished, combat.resolved — so a promotion lands the moment it's
 * earned, with no sweep. Those events come from three different bots; the bus is
 * broadcast, so ONE bot mounts this capability (the builder, which also has
 * `notify` and the land channels to announce in).
 *
 * The promotion is a conditional UPDATE (`WHERE tier < :next`): idempotent under
 * redelivery, race-safe between two events arriving together, and able to climb
 * several tiers at once if the content was retuned downward. A tier is never
 * taken away — lowering a requirement later can only promote.
 */
import type { Tiers, TierRule } from "@empire/content-schemas";
import type { Capability, CapabilityContext } from "../runtime/capability.js";
import type { BusEvent } from "../events/bus.js";
import type { Sql } from "@empire/db";

export interface MilestoneCounts {
  buildings: number;
  research: number;
  victories: number;
}

/** True when `counts` meet every requirement of `rule`. */
function meets(counts: MilestoneCounts, rule: TierRule): boolean {
  return counts.buildings >= rule.buildings && counts.research >= rule.research && counts.victories >= rule.victories;
}

/**
 * The highest tier `counts` qualify for, climbing in order — tier N needs every
 * tier below it too, so a gap in the ladder stops the climb even if a higher
 * tier's numbers happen to be met.
 */
export function eligibleTier(counts: MilestoneCounts, tiers: Tiers): number {
  let tier = 1;
  for (const rule of tiers.tiers) {
    if (!meets(counts, rule)) break;
    tier = rule.tier;
  }
  return tier;
}

/** The next rung above `tier`, or null at the top. */
export function nextTier(tier: number, tiers: Tiers): TierRule | null {
  return tiers.tiers.find((rule) => rule.tier === tier + 1) ?? null;
}

export async function milestoneCounts(sql: Sql, playerId: string): Promise<MilestoneCounts> {
  const [row] = await sql<MilestoneCounts[]>`
    SELECT
      (SELECT count(*)::int FROM build_queue WHERE owner_id = ${playerId} AND status = 'completed') AS buildings,
      (SELECT count(*)::int FROM research WHERE owner_id = ${playerId} AND status = 'done') AS research,
      (SELECT count(*)::int FROM battles WHERE owner_id = ${playerId} AND outcome = 'victory') AS victories
  `;
  return row ?? { buildings: 0, research: 0, victories: 0 };
}

/**
 * /progress: the player's tier and what the next one asks, as counts they can
 * see moving.
 */
export async function progressReport(sql: Sql, playerId: string, tiers: Tiers): Promise<string> {
  const [player] = await sql<{ tier: number }[]>`SELECT tier FROM players WHERE discord_user_id = ${playerId}`;
  const tier = player?.tier ?? 1;
  const name = tiers.tiers.find((rule) => rule.tier === tier)?.name ?? "Newcomer";
  const next = nextTier(tier, tiers);
  if (!next) return `You are **Tier ${tier} — ${name}**, as high as the realm goes.`;
  const counts = await milestoneCounts(sql, playerId);
  const line = (label: string, have: number, need: number) => `${have >= need ? "✅" : "▫️"} ${label}: ${Math.min(have, need)}/${need}`;
  return [
    `You are **Tier ${tier} — ${name}**. To become **Tier ${next.tier} — ${next.name}**:`,
    line("Buildings finished", counts.buildings, next.buildings),
    line("Research completed", counts.research, next.research),
    line("Battles won", counts.victories, next.victories),
  ].join("\n");
}

/** The events after which a milestone count can have changed. */
const MILESTONE_EVENTS = ["build.finished", "research.finished", "combat.resolved"];

export function progressionCapability(tiers: Tiers): Capability {
  return {
    name: "progression",
    consumes: MILESTONE_EVENTS,
    actions: {},

    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      if (!MILESTONE_EVENTS.includes(evt.type)) return;
      if (evt.actor?.kind !== "player") return;
      const player = evt.actor.id;
      // A lost battle moves no count; skip the reads.
      if (evt.type === "combat.resolved" && (evt.payload as { outcome?: string }).outcome !== "victory") return;

      const target = eligibleTier(await milestoneCounts(ctx.sql, player), tiers);
      if (target <= 1) return;
      const [promoted] = await ctx.sql<{ tier: number }[]>`
        UPDATE players SET tier = ${target}
        WHERE discord_user_id = ${player} AND tier < ${target}
        RETURNING tier
      `;
      if (!promoted) return;

      const name = tiers.tiers.find((rule) => rule.tier === target)?.name ?? `Tier ${target}`;
      ctx.logger.info({ player, tier: target }, "player promoted");
      await ctx.bus.publish({
        type: "notify.requested",
        guildId: evt.guildId ?? null,
        actor: { kind: "player", id: player },
        subject: { kind: "npc", id: ctx.bot },
        payload: { message: `🎖️ You have risen to **Tier ${target} — ${name}**. Your champion grows stronger; your works grow grander, and slower.` },
        correlationId: evt.correlationId ?? null,
      });
      // Realm-wide (the Herald's town crier, §9). Anonymous on purpose: the
      // notice is mirrored to continents the player may not belong to, where a
      // mention would render as an unknown user.
      await ctx.bus.publish({
        type: "world.announce",
        guildId: evt.guildId ?? null,
        actor: { kind: "world", id: "progression" },
        payload: { message: `📜 A new **${name}** (Tier ${target}) rises in the realm.` },
        correlationId: evt.correlationId ?? null,
      });
    },
  };
}
