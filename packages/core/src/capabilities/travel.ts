/**
 * travel (framework spec §9) — intercontinental NPC movement. Unlike
 * presence.voice (which stands an NPC in a home voice channel in EVERY guild at
 * once), a traveler is present in exactly ONE continent at a time and walks the
 * continent ring authored in continents.yaml: it dwells in a continent's voice
 * channel, then leaves that guild's voice entirely ("on the road", visible in no
 * channel) before appearing in a neighbouring continent. Each departure/arrival
 * emits a world.rumor other bots' ambient.chatter can react to.
 *
 * The arrive→dwell→depart→transit cadence is a thin two-state workflow (timers);
 * the ring logic + the traveler's position live here. Position persists in
 * npcs.state ({ guild, destination, previous }) so a reboot resumes on the right
 * continent (or stays on the road if it rebooted mid-transit).
 */
import type { Capability, CapabilityContext } from "../capability.js";
import type { Continents } from "@empire/content-schemas";
import { voiceStopChannel } from "../locations.js";
import { jsonParam } from "@empire/db";

/** The voice channel a traveler lingers in on each continent (seeded by world:init). */
const WANDERER_STOP = "market_square_vc";

/** The traveler's persisted position (npcs.state). */
interface TravelState {
  /** The continent (guild id) the traveler stands in; null while on the road. */
  guild?: string | null;
  /** The continent being travelled to; set on departure, cleared on arrival. */
  destination?: string | null;
  /** The continent most recently departed from — avoided when picking the next hop. */
  previous?: string | null;
}

/** The starting continent: the one with the lowest `order` in continents.yaml. */
export function startContinent(continents: Continents): string {
  const entries = Object.entries(continents.continents).sort((a, b) => a[1].order - b[1].order);
  return entries[0]![0];
}

/**
 * The next continent to travel to from `current`: the first neighbour that isn't
 * `avoid` (so the traveler doesn't immediately backtrack), else the first
 * neighbour, else `current` (a lone continent). Deterministic — a 2-continent
 * ring ping-pongs, a directed/bidirectional 3-ring walks forward.
 */
export function nextContinent(continents: Continents, current: string, avoid?: string | null): string {
  const neighbors = continents.continents[current]?.neighbors ?? [];
  if (neighbors.length === 0) return current;
  return neighbors.find((n) => n !== avoid) ?? neighbors[0]!;
}

export function travelCapability(continents: Continents): Capability {
  async function readState(ctx: CapabilityContext): Promise<TravelState> {
    const [row] = await ctx.sql<{ state: TravelState }[]>`SELECT state FROM npcs WHERE id = ${ctx.bot}`;
    return row?.state ?? {};
  }

  async function writeState(ctx: CapabilityContext, next: TravelState): Promise<void> {
    await ctx.sql`UPDATE npcs SET state = ${jsonParam(ctx.sql, next)} WHERE id = ${ctx.bot}`;
  }

  /**
   * Appear in a continent's voice stop and record position. `announce` emits the
   * arrival rumour — true for a real hop (travel.enter), false when merely
   * restoring presence after a reboot (init), so a restart doesn't broadcast a
   * fresh arrival for travel that never happened (mirrors presence.voice's boot join).
   */
  async function appear(ctx: CapabilityContext, guildId: string, stop: string, previous: string | null, announce: boolean): Promise<void> {
    const channelId = await voiceStopChannel(ctx.sql, guildId, stop);
    if (!channelId) {
      ctx.logger.warn({ guildId, stop }, "no voice channel mapped for travel stop — run world:init");
      return;
    }
    const joined = await ctx.gateway.joinVoice(guildId, channelId);
    if (!joined) return;
    await writeState(ctx, { guild: guildId, destination: null, previous });
    if (announce) {
      const name = continents.continents[guildId]?.name ?? "a distant shore";
      await ctx.bus.publish({
        type: "world.rumor",
        guildId,
        subject: { kind: "npc", id: ctx.bot },
        payload: { hint: `A hooded stranger has been glimpsed in ${name} — no one saw them cross the water.` },
      });
    }
    ctx.logger.info({ guildId, stop, announce }, "traveler arrived");
  }

  return {
    name: "travel",
    consumes: [],

    /**
     * Restore presence on boot: ensure the npcs row exists (position lives in its
     * state), then — if settled on a continent (guild set, not mid-transit) —
     * rejoin that continent's stop so a mid-dwell reboot looks unchanged. When on
     * the road (destination set) or never-started (empty state), join nothing:
     * the workflow's first travel.enter handles the initial appearance.
     */
    async init(ctx: CapabilityContext): Promise<void> {
      await ctx.sql`INSERT INTO npcs (id, kind) VALUES (${ctx.bot}, 'wanderer') ON CONFLICT DO NOTHING`;
      const state = await readState(ctx);
      if (state.destination) return; // mid-transit — stay on the road
      if (state.guild) await appear(ctx, state.guild, WANDERER_STOP, state.previous ?? null, false); // silent presence restore
    },

    actions: {
      // Arrive at the next continent (or the starting one on the first ever hop):
      // join its voice stop, record position, announce with a rumour.
      "travel.enter": async (args, _evt, ctx: CapabilityContext) => {
        const state = await readState(ctx);
        const dest = state.destination ?? startContinent(continents);
        const stop = args.channel ? String(args.channel) : WANDERER_STOP;
        await appear(ctx, dest, stop, state.previous ?? null, true);
      },

      // Depart the current continent: leave its voice (now "on the road"), pick
      // the next continent from the ring, remember it, and announce the exit.
      "travel.leave": async (_args, _evt, ctx: CapabilityContext) => {
        const state = await readState(ctx);
        const current = state.guild ?? startContinent(continents);
        const next = nextContinent(continents, current, state.previous);
        ctx.gateway.leaveVoice(current);
        await writeState(ctx, { guild: null, destination: next, previous: current });
        const name = continents.continents[current]?.name ?? "the port";
        await ctx.bus.publish({
          type: "world.rumor",
          guildId: current,
          subject: { kind: "npc", id: ctx.bot },
          payload: { hint: `The hooded stranger has slipped out of ${name}, bound for parts unknown.` },
        });
        ctx.logger.info({ from: current, to: next }, "traveler departed");
      },
    },
  };
}
