/**
 * combat (framework spec §2.6, §5.13) — encounters & dispatch.
 *
 * Two verb chains, both driven by declarative workflows (§7) rather than by an
 * imperative handle(), exactly like `land` and `research`:
 *
 *   MUSTER  (content/workflows/warden_muster.yaml) — muster.request guards and
 *           charges via `trade`; muster.enqueue times the training once the
 *           charge settles; muster.complete is the tick firing; muster.reject
 *           cleans up a failed charge. Structurally a sibling of the build and
 *           research queues, down to the correlation-keyed pending row.
 *
 *   DISPATCH (content/workflows/warden_dispatch.yaml) — dispatch.request
 *           assembles a force and sends it with a travel timer; combat.resolve
 *           runs the seeded fight on arrival and delivers the log;
 *           dispatch.return brings the survivors home.
 *
 * The dispatch half is deliberately generic (§5.13: the primitive is "shared
 * with future trade agents"). A dispatch row is a force + a position + a timer
 * + a MISSION, and `mission.kind` is the only thing that says "battle". §11's
 * caravans should arrive as a new mission kind handled by a new verb, with this
 * request/arrive/return skeleton untouched.
 *
 * Two invariants shape the code more than anything else:
 *   - Only `trade` writes the ledger. The muster charge is a trade.request; the
 *     loot is a `grant.requested` addressed to this bot's own trade capability.
 *     This capability never touches balances, inventories or ledger.
 *   - §2.6 rules out PvE losses. Units are therefore never destroyed — they are
 *     tied up in `dispatched` for the round trip and come back whole. The cost
 *     of a fight is time and the gold already sunk into mustering.
 */
import { ulid } from "ulid";
import type { Capability, CapabilityContext } from "../runtime/capability.js";
import { payloadString } from "../events/helpers.js";
import { publishReply } from "../events/reply.js";
import { playerTier, tierScaledMs } from "../world/players.js";
import { landChannel } from "../world/locations.js";
import { returnDispatch } from "../world/dispatch.js";
import { MUSTER_PERMIT_ITEM } from "../world/items.js";
import { battleLogEmbed } from "../ui/kit.js";
import { resolveBattle, rollLoot, type Force, type ForceTroop, type LootEntry } from "../combat/resolve.js";
import { BASE_STATS, MUSTER_COST, championStats, isUnitType, type UnitType } from "../combat/types.js";
import { ensurePlayer, jsonParam, DEFAULT_STARTING_GOLD, type Sql } from "@empire/db";
import type { Encounters } from "@empire/content-schemas";
import { syncEncounters } from "../world/catalogs.js";

/** Training time per troop before tier scaling (§2.5 idle pacing). */
export const MUSTER_MS_PER_TROOP = 60_000;

/** The most troops one /muster may raise — keeps a single command from eating a bank. */
export const MAX_MUSTER = 20;

/**
 * The blueprint that must be BUILT before a player can raise troops — §2.6's
 * "troops … produced by buildings", expressed with the existing build queue
 * rather than a second production system.
 */
export const BARRACKS_BLUEPRINT = "barracks";

/** The champion's type. Equipment (§2.6) will make this a choice; for now the
 *  hero is a frontline fighter. */
const CHAMPION_TYPE: UnitType = "infantry";

interface EncounterRow {
  id: string;
  name: string;
  unit_type: UnitType;
  atk: number;
  def: number;
  hp: number;
  travel_ms: number;
  loot: LootEntry[];
  reward_gold: number;
}

async function loadEncounter(sql: Sql, id: string): Promise<EncounterRow | null> {
  const [row] = await sql<EncounterRow[]>`
    SELECT id, name, unit_type, atk, def, hp, travel_ms, loot, reward_gold
    FROM encounter_catalog WHERE id = ${id}
  `;
  return row ?? null;
}

/** True once the player has a FINISHED barracks (a queued one doesn't count). */
async function hasBarracks(sql: Sql, playerId: string): Promise<boolean> {
  const [row] = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM build_queue
    WHERE owner_id = ${playerId} AND blueprint_id = ${BARRACKS_BLUEPRINT} AND status = 'completed'
    LIMIT 1
  `;
  return Boolean(row);
}

interface UnitRow {
  id: string;
  kind: string;
  unit_type: UnitType;
  qty: number;
  atk: number;
  def: number;
  hp: number;
  status: string;
}

/**
 * The player's champion, created on first dispatch (the auto-provision-on-first
 * -use philosophy `ensurePlot` follows). Its stat block is REFRESHED from the
 * player's tier on every call rather than stored once: §2.6 has power flowing
 * from progression, and deriving it means there is no second place for a
 * champion's strength to drift out of sync with the player's.
 */
async function ensureChampion(ctx: CapabilityContext, playerId: string, guildId: string | null): Promise<UnitRow> {
  const tier = await playerTier(ctx.sql, playerId);
  const stats = championStats(tier);
  const [row] = await ctx.sql<UnitRow[]>`
    INSERT INTO units (id, owner_id, kind, unit_type, qty, atk, def, hp, status, position_guild_id)
    VALUES (${`champion_${playerId}`}, ${playerId}, 'champion', ${CHAMPION_TYPE}, 1,
            ${stats.atk}, ${stats.def}, ${stats.hp}, 'idle', ${guildId})
    ON CONFLICT (id) DO UPDATE SET atk = ${stats.atk}, def = ${stats.def}, hp = ${stats.hp}
    RETURNING id, kind, unit_type, qty, atk, def, hp, status
  `;
  return row!;
}

/** A unit row as the resolver wants it. */
function toTroop(row: UnitRow): ForceTroop {
  return { unitId: row.id, unitType: row.unit_type, qty: row.qty, atk: row.atk, def: row.def, hp: row.hp };
}

/** "6× infantry" / "Champion (infantry)" lines for the resolution-log embed. */
function describeForce(force: Force): string[] {
  const lines = force.troops.map((t) => `${t.qty}× ${t.unitType}`);
  if (force.champion) lines.unshift(`Champion (${force.champion.unitType}, lvl ${force.champion.level})`);
  return lines;
}

/** `bestiary` is the encounter YAML (§1.3); when given, it is synced on boot. */
export function combatCapability(bestiary?: Encounters): Capability {
  /**
   * Deliver the resolution log to a private thread off the player's land
   * channel (§2.6 "delivered as a resolution log in a private thread").
   * Best-effort in two stages, mirroring `land`'s provisioning: with no thread
   * the log still posts to the land channel, and with no land channel at all
   * the battle row remains the record. A fight must never fail to resolve
   * because Discord refused a thread.
   */
  async function deliverLog(
    ctx: CapabilityContext,
    playerId: string,
    encounterName: string,
    embed: ReturnType<typeof battleLogEmbed>,
  ): Promise<string | null> {
    const channelId = await landChannel(ctx.sql, playerId);
    if (!channelId) {
      ctx.logger.warn({ player: playerId }, "no land channel; battle log lives only in the battles row");
      return null;
    }
    const threadId = await ctx.gateway.createPrivateThread(channelId, `Battle · ${encounterName}`, playerId);
    const target = threadId ?? channelId;
    if (!threadId) ctx.logger.warn({ player: playerId }, "battle thread creation failed; posting to the land channel");
    await ctx.gateway.sendToChannel(target, { embeds: [embed.toJSON()] });
    return threadId;
  }

  return {
    name: "combat",
    async init(ctx: CapabilityContext): Promise<void> {
      if (!bestiary) return;
      await syncEncounters(ctx.sql, bestiary);
      ctx.logger.info({ encounters: bestiary.encounters.length }, "encounter catalog synced from content");
    },
    // Nothing imperative to consume — the warden_muster and warden_dispatch
    // workflows (§7) drive both chains; the runtime dispatches the verbs.
    consumes: [],
    actions: {
      /**
       * /muster entry: guards (registered, real type, sane count, a BUILT
       * barracks) → charge via `trade`. The pending stack is a 'training' unit
       * row with ready_at NULL — the carry across the async charge — keyed by
       * the instance's correlation so concurrent musters stay apart. A guard
       * failure replies and THROWS so the workflow's on_error routes to cleanup.
       */
      "muster.request": async (_args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        const correlationId = evt?.correlationId ?? null;
        const guildId = evt?.guildId ?? null;
        const rawType = payloadString(evt, "type");
        const rawCount = payloadString(evt, "count");

        // Guard: player registered (auto-register on first interaction, §2.1).
        const homeGuildId = ctx.personas.homeGuild(guildId);
        const { created } = await ensurePlayer(ctx.sql, player, homeGuildId, DEFAULT_STARTING_GOLD);
        if (created) ctx.logger.info({ player, startingGold: DEFAULT_STARTING_GOLD }, "player registered via /muster");

        // Guard: a real unit type.
        if (!rawType || !isUnitType(rawType)) {
          await publishReply(ctx, "muster.rejected", { guildId, correlationId }, player, "I train infantry, cavalry and archers — nothing else.");
          throw new Error("invalid unit type");
        }
        const unitType: UnitType = rawType;

        // Guard: a sane headcount. Parsed strictly — "3 or so" is not a number.
        const count = Number(rawCount);
        if (!Number.isInteger(count) || count < 1 || count > MAX_MUSTER) {
          await publishReply(ctx, "muster.rejected", { guildId, correlationId }, player, `Name a number between 1 and ${MAX_MUSTER}, recruit.`);
          throw new Error("invalid muster count");
        }

        // Guard: §2.6 — troops come out of buildings, so the barracks must stand.
        if (!(await hasBarracks(ctx.sql, player))) {
          await publishReply(ctx, "muster.rejected", { guildId, correlationId }, player, "You've nowhere to drill them. Build a barracks first.");
          throw new Error("no barracks");
        }

        const stats = BASE_STATS[unitType];
        await ctx.sql`
          INSERT INTO units (id, owner_id, kind, unit_type, qty, atk, def, hp, status, ready_at, correlation_id, position_guild_id)
          VALUES (${`unit_${ulid()}`}, ${player}, 'troop', ${unitType}, ${count},
                  ${stats.atk}, ${stats.def}, ${stats.hp}, 'training', NULL, ${correlationId}, ${homeGuildId})
        `;
        // Deduct through `trade` (invariant #2): the atomic trade is the
        // authority on affordability, and trade.failed → muster.reject turns a
        // shortfall into an in-fiction rejection.
        await ctx.bus.publish({
          type: "trade.request",
          guildId,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: { item: MUSTER_PERMIT_ITEM, qty: 1, price: MUSTER_COST[unitType] * count },
          correlationId,
        });
      },

      /** Charge settled: give this muster's pending stack a tier-scaled timer. */
      "muster.enqueue": async (_args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        const correlationId = evt?.correlationId ?? null;
        if (!player) return;
        const [pending] = await ctx.sql<{ id: string; qty: number; unit_type: string }[]>`
          SELECT id, qty, unit_type FROM units
          WHERE owner_id = ${player} AND correlation_id = ${correlationId}
            AND status = 'training' AND ready_at IS NULL
          ORDER BY id DESC LIMIT 1
        `;
        if (!pending) {
          ctx.logger.warn({ player, correlationId }, "muster.enqueue: no pending stack for this charge");
          return;
        }
        const tier = await playerTier(ctx.sql, player);
        const durationMs = tierScaledMs(MUSTER_MS_PER_TROOP * pending.qty, tier);
        const readyAt = new Date(Date.now() + durationMs);
        await ctx.sql`UPDATE units SET ready_at = ${readyAt.toISOString()} WHERE id = ${pending.id}`;
        const mins = Math.max(1, Math.round(durationMs / 60000));
        ctx.logger.info({ player, unit: pending.id, durationMs }, "muster started");
        await ctx.bus.publish({
          type: "muster.queued",
          guildId: evt?.guildId ?? null,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: {
            unit_id: pending.id,
            ready_at: readyAt.toISOString(),
            message: `Drilling **${pending.qty}× ${pending.unit_type}** — ready in ~${mins}m.`,
          },
          correlationId,
        });
      },

      /**
       * Tick's muster.completed(unit_id): the stack joins the standing army.
       * Guarded on status='training' so a redelivered tick returns no row and
       * no-ops — the same exactly-once shape as build.complete.
       */
      "muster.complete": async (_args, evt, ctx: CapabilityContext) => {
        const unitId = payloadString(evt, "unit_id");
        if (!unitId) return;
        const [row] = await ctx.sql<{ owner_id: string; qty: number; unit_type: string }[]>`
          UPDATE units SET status = 'idle' WHERE id = ${unitId} AND status = 'training'
          RETURNING owner_id, qty, unit_type
        `;
        if (!row) return;
        ctx.logger.info({ unitId, unitType: row.unit_type, qty: row.qty }, "muster completed");
        await ctx.bus.publish({
          type: "notify.requested",
          guildId: evt?.guildId ?? null,
          actor: { kind: "player", id: row.owner_id },
          subject: { kind: "npc", id: ctx.bot },
          payload: { message: `${row.qty}× ${row.unit_type} have joined your ranks.` },
        });
      },

      /**
       * Charge failed or timed out: discard this muster's pending stack.
       * Correlation-keyed, so concurrent musters are untouched; on the timeout
       * path the runtime's synthetic timer event supplies player + correlation.
       */
      "muster.reject": async (args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        const correlationId = evt?.correlationId ?? null;
        const message = String((args as { message?: unknown }).message ?? "That muster fell through, recruit.");
        if (player) {
          await ctx.sql`
            DELETE FROM units
            WHERE owner_id = ${player} AND correlation_id = ${correlationId}
              AND status = 'training' AND ready_at IS NULL
          `;
        }
        await publishReply(ctx, "muster.rejected", evt, player ?? "", message);
      },

      /**
       * /dispatch entry: assemble every idle unit plus the champion, snapshot
       * the force onto a dispatch row, and send it with a travel timer. No gold
       * changes hands — §2.6 prices a fight in sunk prep and time, not a fee.
       *
       */
      "dispatch.request": async (_args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        const correlationId = evt?.correlationId ?? null;
        const guildId = evt?.guildId ?? null;
        const encounterId = payloadString(evt, "encounter");

        const homeGuildId = ctx.personas.homeGuild(guildId);
        const { created } = await ensurePlayer(ctx.sql, player, homeGuildId, DEFAULT_STARTING_GOLD);
        if (created) ctx.logger.info({ player, startingGold: DEFAULT_STARTING_GOLD }, "player registered via /dispatch");

        // Guard: a real encounter.
        const encounter = encounterId ? await loadEncounter(ctx.sql, encounterId) : null;
        if (!encounter) {
          await publishReply(ctx, "dispatch.rejected", { guildId, correlationId }, player, "No such quarry is abroad, commander.");
          throw new Error("invalid encounter");
        }

        // The champion always rides along, so its status is a reliable proxy for
        // "this player already has a dispatch in flight".
        const champion = await ensureChampion(ctx, player, homeGuildId);
        if (champion.status === "dispatched") {
          await publishReply(ctx, "dispatch.rejected", { guildId, correlationId }, player, "Your champion is already afield. Await their return.");
          throw new Error("champion already dispatched");
        }

        const troops = await ctx.sql<UnitRow[]>`
          SELECT id, kind, unit_type, qty, atk, def, hp, status FROM units
          WHERE owner_id = ${player} AND kind = 'troop' AND status = 'idle' AND qty > 0
          ORDER BY id ASC
        `;

        const tier = await playerTier(ctx.sql, player);
        const force: Force = {
          troops: troops.map(toTroop),
          champion: {
            unitId: champion.id,
            unitType: champion.unit_type,
            level: tier,
            atk: champion.atk,
            def: champion.def,
            hp: champion.hp,
          },
        };

        const dispatchId = `dsp_${ulid()}`;
        const arrivesAt = new Date(Date.now() + Number(encounter.travel_ms));
        await ctx.sql`
          INSERT INTO dispatches (id, owner_id, mission, force, origin_guild_id, status, arrives_at, correlation_id)
          VALUES (${dispatchId}, ${player},
                  ${jsonParam(ctx.sql, { kind: "battle", encounter_id: encounter.id })},
                  ${jsonParam(ctx.sql, force)}, ${homeGuildId}, 'travelling',
                  ${arrivesAt.toISOString()}, ${correlationId})
        `;
        // Tie the force up for the round trip. Scoped to exactly the ids that
        // were snapshotted, so a stack mustered in the meantime stays home
        // rather than being silently swept into a fight it wasn't in.
        const sent = [champion.id, ...troops.map((t) => t.id)];
        await ctx.sql`UPDATE units SET status = 'dispatched' WHERE id = ANY(${sent})`;

        const mins = Math.max(1, Math.round(Number(encounter.travel_ms) / 60000));
        ctx.logger.info({ player, dispatchId, encounter: encounter.id, units: sent.length }, "force dispatched");
        await ctx.bus.publish({
          type: "dispatch.sent",
          guildId,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: {
            dispatch_id: dispatchId,
            encounter: encounter.id,
            arrives_at: arrivesAt.toISOString(),
            message: `Your force marches on **${encounter.name}** — they arrive in ~${mins}m.`,
          },
          correlationId,
        });
      },

      /**
       * Tick's dispatch.arrived(dispatch_id): run the fight and deliver the log.
       *
       * EVERYTHING THAT MATTERS COMMITS TOGETHER. The fight is rolled first,
       * which is pure, and then one transaction claims the dispatch
       * (travelling→returning), records the battle and emits the grants and
       * combat.resolved through the bus's transactional publish. There is no
       * intermediate state to strand: a crash before the commit leaves the row
       * `travelling` for the tick to re-fire (a fresh roll, nothing granted yet),
       * and a crash after it only loses the Discord post, which is best-effort
       * anyway because the battles row is the record. (An earlier version
       * parked the row in a `resolving` state across all of that, and a crash
       * there tied the champion up forever, since nothing sweeps `resolving`.)
       *
       * The claim is a conditional UPDATE, so a redelivered tick (or two bots
       * racing) finds no row, rolls back and grants nothing. It also pins
       * `mission->>'kind' = 'battle'`: the tick sweeps every travelling dispatch
       * regardless of mission, and a §11 caravan in flight must not be marched
       * into a fight. Dispatch rows are a shared primitive, not combat's alone.
       */
      "combat.resolve": async (_args, evt, ctx: CapabilityContext) => {
        const dispatchId = payloadString(evt, "dispatch_id");
        if (!dispatchId) return;
        const [row] = await ctx.sql<
          { owner_id: string; mission: { encounter_id?: string }; force: Force; origin_guild_id: string | null }[]
        >`
          SELECT owner_id, mission, force, origin_guild_id FROM dispatches
          WHERE id = ${dispatchId} AND status = 'travelling' AND mission->>'kind' = 'battle'
        `;
        if (!row) return;

        const player = row.owner_id;
        const guildId = evt?.guildId ?? row.origin_guild_id;
        const encounter = row.mission?.encounter_id ? await loadEncounter(ctx.sql, row.mission.encounter_id) : null;
        if (!encounter) {
          // The catalog row vanished under a dispatch in flight. Send the force
          // home rather than stranding it — the units matter more than the fight.
          ctx.logger.error({ dispatchId, mission: row.mission }, "dispatch arrived at an unknown encounter; recalling");
          await ctx.sql`
            UPDATE dispatches SET status = 'returning', returns_at = now()
            WHERE id = ${dispatchId} AND status = 'travelling' AND mission->>'kind' = 'battle'
          `;
          return;
        }

        const seed = ulid();
        const result = resolveBattle({
          force: row.force,
          encounter: {
            id: encounter.id,
            name: encounter.name,
            unitType: encounter.unit_type,
            atk: encounter.atk,
            def: encounter.def,
            hp: encounter.hp,
          },
          seed,
        });
        // §2.6: losing costs only the loot chance — so the roll happens on a win.
        const loot = result.outcome === "victory" ? rollLoot(encounter.loot ?? [], seed) : [];
        const gold = result.outcome === "victory" ? Number(encounter.reward_gold) : 0;
        const battleId = `btl_${ulid()}`;
        // The return leg reuses the outbound time.
        const returnsAt = new Date(Date.now() + Number(encounter.travel_ms));

        const committed = await ctx.sql.begin(async (tx) => {
          const [claimed] = await tx<{ id: string }[]>`
            UPDATE dispatches SET status = 'returning', returns_at = ${returnsAt.toISOString()}
            WHERE id = ${dispatchId} AND status = 'travelling' AND mission->>'kind' = 'battle'
            RETURNING id
          `;
          if (!claimed) return false;

          await tx`
            INSERT INTO battles (id, dispatch_id, owner_id, encounter_id, seed, outcome, rounds, loot, thread_id)
            VALUES (${battleId}, ${dispatchId}, ${player}, ${encounter.id}, ${seed}, ${result.outcome},
                    ${jsonParam(tx, result.rounds)}, ${jsonParam(tx, loot)}, NULL)
          `;

          // Spoils go through `trade` (invariant #2): this capability computes the
          // reward but never writes the ledger. One request per component, so each
          // lands as its own auditable ledger row. Emitted inside the transaction,
          // so a rolled-back fight can never have paid out.
          for (const spec of [...(gold > 0 ? [{ gold }] : []), ...loot.map((l) => ({ item: l.item, qty: l.qty }))]) {
            await ctx.bus.publish(
              {
                type: "grant.requested",
                guildId,
                actor: { kind: "player", id: player },
                subject: { kind: "npc", id: ctx.bot },
                payload: spec,
                correlationId: evt?.correlationId ?? null,
              },
              tx,
            );
          }
          await ctx.bus.publish(
            {
              type: "combat.resolved",
              guildId,
              actor: { kind: "player", id: player },
              subject: { kind: "npc", id: ctx.bot },
              payload: { dispatch_id: dispatchId, encounter: encounter.id, outcome: result.outcome, seed },
              correlationId: evt?.correlationId ?? null,
            },
            tx,
          );
          return true;
        });
        if (!committed) return;
        ctx.logger.info({ dispatchId, outcome: result.outcome, rounds: result.rounds.length, seed }, "battle resolved");

        // Presentation, after the fact and best-effort (§2.6 "delivered as a
        // resolution log in a private thread").
        const embed = battleLogEmbed({
          encounter: encounter.name,
          outcome: result.outcome,
          force: describeForce(row.force),
          rounds: result.rounds.map((r) => r.line),
          loot: [...(gold > 0 ? [`${gold} gold`] : []), ...loot.map((l) => `${l.qty}× ${l.item}`)],
          seed,
        });
        const threadId = await deliverLog(ctx, player, encounter.name, embed);
        if (threadId) await ctx.sql`UPDATE battles SET thread_id = ${threadId} WHERE id = ${battleId}`;
      },

      /**
       * Tick's dispatch.returned(dispatch_id): the force comes home whole (§2.6
       * — no PvE losses) and is free to be sent again. Guarded on
       * status='returning' so a redelivered tick no-ops.
       */
      "dispatch.return": async (_args, evt, ctx: CapabilityContext) => {
        const dispatchId = payloadString(evt, "dispatch_id");
        if (!dispatchId) return;
        // Shared with `caravan`, which rides the same table: the claim frees only
        // this mission's own units, and only if the row is a battle at all.
        const returned = await returnDispatch(ctx.sql, dispatchId, "battle");
        if (!returned) return;
        ctx.logger.info({ dispatchId, units: returned.unitIds.length }, "force returned");
        await ctx.bus.publish({
          type: "notify.requested",
          guildId: evt?.guildId ?? null,
          actor: { kind: "player", id: returned.ownerId },
          subject: { kind: "npc", id: ctx.bot },
          payload: { message: "Your force has returned and stands ready." },
        });
      },
    },
  };
}
