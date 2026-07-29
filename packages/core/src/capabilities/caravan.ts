/**
 * caravan (framework spec §11 "trade agents & caravans", §2.3 "an agent on site")
 * — the remote trade posting.
 *
 * A caravan is NOT an autonomous trader. It is a unit you post to another
 * continent so that you can trade with it at all: while it is stationed there it
 * runs a stall in your home land plot, and it satisfies the third §2.3 gate that
 * `world/commerce.ts` had left open. §2.3 says the third presence tier is being
 * there "(or, in the future, an agent unit acting for you)" — this is that agent.
 *
 * It rides the §5.13 dispatch primitive as a second mission kind rather than a
 * second table, which is what `schema.ts` predicted it would. The consequence
 * worth remembering: the tick sweeps `dispatches` by status alone, so every claim
 * here is filtered by mission kind (see world/dispatch.ts) or the Warden's verbs
 * and these would fight over each other's rows.
 *
 * Three deliberate shapes:
 *   - THE PERSONA IS THE CARAVAN'S, never the source merchant's. Gameplay-wise
 *     you are dealing with your own caravan, which sources goods abroad on your
 *     behalf; Aldric is not visible in your land plot and is never named there.
 *   - THE SELLER OF RECORD IS STILL THE SOURCE NPC. Goods come out of real
 *     inventory or the caravan becomes a gold-for-nothing item faucet. The
 *     persona is presentation; the ledger stays honest.
 *   - NO HAGGLING. Your factor pays the asking price (`base_price`, with
 *     `effectiveFloor` never consulted). Haggling needs you there in person —
 *     that is the trade-off that keeps travelling worth doing.
 */
import type { Continents, Shop } from "@empire/content-schemas";
import type { Capability, CapabilityContext } from "../runtime/capability.js";
import type { BusEvent } from "../events/bus.js";
import type { ComponentInteraction } from "../gateway/index.js";
import { stallEmbed, buttonRow } from "../ui/kit.js";
import { notForMe, payloadString } from "../events/helpers.js";
import { publishReply, replyToCommand } from "../events/reply.js";
import { landChannelIn } from "../world/locations.js";
import { returnDispatch } from "../world/dispatch.js";
import { isOwnNpc } from "../world/npc-identity.js";
import { tradeRoutesAndPostBlock } from "../world/commerce.js";
import { executeTrade, ensurePlayer, jsonParam, DEFAULT_STARTING_GOLD, type Sql } from "@empire/db";
import { ulid } from "ulid";

/** The mission kind this capability owns on the shared `dispatches` table. */
export const CARAVAN_MISSION = "caravan";

/**
 * One-way travel time. Matches player_travel.yaml's 3m intercontinental leg —
 * a caravan crosses the same water a player does, so it takes the same time.
 */
export const CARAVAN_TRAVEL_MS = 3 * 60_000;

/** Which NPC's stock a caravan sources from (seeded by world:init). */
const SOURCE_NPC_KIND = "merchant";

/** Button custom-id scheme: `crv:buy:<dispatchId>:<itemId>`. */
const CUSTOM_ID = /^crv:buy:([^:]+):(.+)$/;

/** Discord's per-message limits: 5 action rows × 5 buttons. */
const BUTTONS_PER_ROW = 5;
const MAX_WARES = BUTTONS_PER_ROW * 5;

interface DispatchRow {
  id: string;
  owner_id: string;
  mission: { kind?: string; destination_guild_id?: string; stall_message_id?: string };
  origin_guild_id: string | null;
  status: string;
}

export function caravanCapability(shop: Shop, continents: Continents): Capability {
  const continentName = (guildId: string): string => continents.continents[guildId]?.name ?? "distant shores";

  /** The NPC whose stock the caravan sources from, or null if world:init hasn't run. */
  async function sourceNpc(sql: Sql): Promise<string | null> {
    const [row] = await sql<{ id: string }[]>`SELECT id FROM npcs WHERE kind = ${SOURCE_NPC_KIND} LIMIT 1`;
    return row?.id ?? null;
  }

  /**
   * The wares a caravan can offer: shop content for names and prices, live NPC
   * inventory for stock — the same pairing `stall` uses, so the caravan can
   * never advertise something the merchant has already sold.
   *
   * Note that NPC inventory is not per-continent today (§2.5's `origin_continent`
   * local goods are unimplemented), so the fiction of "wares out of Thornwild" is
   * ahead of the model. When local goods land, this is the query that changes.
   */
  async function wares(sql: Sql, npcId: string) {
    const rows = await sql<{ item_id: string; qty: number }[]>`
      SELECT item_id, qty FROM inventories WHERE owner_kind = 'npc' AND owner_id = ${npcId}
    `;
    const stockById = new Map(rows.map((r) => [r.item_id, r.qty]));
    return shop.items
      .map((item) => ({ itemId: item.item_id, name: item.name, price: item.base_price, stock: stockById.get(item.item_id) ?? item.stock }))
      .slice(0, MAX_WARES);
  }

  /**
   * Draw (or redraw) the caravan's stall in the owner's HOME land plot — the
   * plot on `origin_guild_id`, not just any plot of theirs, since the whole point
   * is that the goods are on another continent (see landChannelIn).
   */
  async function renderStall(ctx: CapabilityContext, dispatch: DispatchRow): Promise<void> {
    const home = dispatch.origin_guild_id;
    const destination = dispatch.mission?.destination_guild_id;
    if (!home || !destination) return;
    const channelId = await landChannelIn(ctx.sql, dispatch.owner_id, home);
    if (!channelId) {
      ctx.logger.warn({ dispatch: dispatch.id, owner: dispatch.owner_id }, "no home land channel for the caravan stall");
      return;
    }
    const npcId = await sourceNpc(ctx.sql);
    if (!npcId) {
      ctx.logger.warn({ dispatch: dispatch.id }, "no source merchant seeded — run world:init");
      return;
    }
    const items = await wares(ctx.sql, npcId);
    // The caravan's OWN face: the source merchant's persona and nickname are
    // never read here, so nothing of Aldric can leak into the player's land.
    const embed = stallEmbed(`🐪 Your Caravan — wares out of ${continentName(destination)}`, items)
      .setFooter({ text: "Your factor pays the asking price. Haggle in person for better terms." });
    const rows: unknown[] = [];
    for (let i = 0; i < items.length; i += BUTTONS_PER_ROW) {
      rows.push(
        buttonRow(
          items.slice(i, i + BUTTONS_PER_ROW).map((item) => ({
            id: `crv:buy:${dispatch.id}:${item.itemId}`,
            label: `${item.name} (${item.price}g)`,
            disabled: item.stock <= 0,
          })),
        ).toJSON(),
      );
    }
    const messageId = await ctx.gateway.upsertPinnedMessage(channelId, dispatch.mission?.stall_message_id ?? null, {
      embeds: [embed.toJSON()],
      components: rows as never[],
    });
    if (messageId && messageId !== dispatch.mission?.stall_message_id) {
      await ctx.sql`
        UPDATE dispatches SET mission = mission || ${jsonParam(ctx.sql, { stall_message_id: messageId })}
        WHERE id = ${dispatch.id}
      `;
    }
  }

  /** Close the stall down to a plain notice with no buttons (the caravan has left). */
  async function closeStall(ctx: CapabilityContext, dispatch: DispatchRow): Promise<void> {
    const home = dispatch.origin_guild_id;
    const messageId = dispatch.mission?.stall_message_id;
    if (!home || !messageId) return;
    const channelId = await landChannelIn(ctx.sql, dispatch.owner_id, home);
    if (!channelId) return;
    // Edited rather than deleted: the land channel keeps the record of the
    // posting, and there is no gateway delete to reach for.
    const embed = stallEmbed(`🐪 Your Caravan — homeward from ${continentName(dispatch.mission?.destination_guild_id ?? "")}`, []);
    await ctx.gateway.upsertPinnedMessage(channelId, messageId, { embeds: [embed.toJSON()], components: [] });
  }

  async function loadDispatch(sql: Sql, id: string): Promise<DispatchRow | null> {
    const [row] = await sql<DispatchRow[]>`
      SELECT id, owner_id, mission, origin_guild_id, status FROM dispatches WHERE id = ${id}
    `;
    return row ?? null;
  }

  /** A click on one of the caravan's wares: a plain, atomic, list-price purchase. */
  async function buyFromCaravan(interaction: ComponentInteraction, dispatchId: string, itemId: string, ctx: CapabilityContext): Promise<void> {
    const buyer = interaction.userId;
    const dispatch = await loadDispatch(ctx.sql, dispatchId);
    if (!dispatch || dispatch.mission?.kind !== CARAVAN_MISSION) {
      await interaction.reply("*That caravan is no longer yours to trade through.*");
      return;
    }
    // The land plot is private, but a stale button outlives the posting: re-check
    // BOTH ownership and that the caravan is still standing there.
    if (dispatch.owner_id !== buyer) {
      await interaction.reply("*That caravan answers to someone else.*");
      return;
    }
    if (dispatch.status !== "stationed") {
      await interaction.reply("*Your caravan has left that market — send it out again.*");
      return;
    }
    const item = shop.items.find((i) => i.item_id === itemId);
    if (!item) {
      await interaction.reply("*Your factor can't lay hands on that.*");
      return;
    }
    const npcId = await sourceNpc(ctx.sql);
    if (!npcId) {
      await interaction.reply("*No trade is moving out there today.*");
      return;
    }
    // No claim row to take: the goods are NPC stock, and executeTrade's
    // conditional `WHERE qty >= :qty` is itself the race-safe stock guard.
    const result = await executeTrade(ctx.sql, {
      eventId: `evt_${ulid()}`,
      buyer: { kind: "player", id: buyer },
      seller: { kind: "npc", id: npcId },
      itemId,
      qty: 1,
      price: item.base_price,
      guildId: dispatch.origin_guild_id,
      reason: "caravan_purchase",
    });
    if (!result.ok) {
      await interaction.reply(`*Your caravan returns empty-handed: ${result.message ?? result.reason}.*`);
      return;
    }
    await interaction.reply(`Your caravan brings back **1× ${item.name}** for **${item.base_price} gold**.`);
    await renderStall(ctx, dispatch);
  }

  /** `/caravan recall` — start the journey home; the tick closes the leg. */
  async function recallCaravan(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
    const player = evt.actor?.id;
    if (!player) return;
    const destination = payloadString(evt, "destination");
    const [row] = await ctx.sql<DispatchRow[]>`
      UPDATE dispatches SET status = 'returning', returns_at = ${new Date(Date.now() + CARAVAN_TRAVEL_MS).toISOString()}
      WHERE owner_id = ${player} AND status = 'stationed' AND mission->>'kind' = ${CARAVAN_MISSION}
        AND mission->>'destination_guild_id' = ${destination}
      RETURNING id, owner_id, mission, origin_guild_id, status
    `;
    if (!row) {
      await replyToCommand(ctx, evt, player, "You've no caravan posted there to call home.");
      return;
    }
    await closeStall(ctx, row);
    ctx.logger.info({ player, dispatch: row.id }, "caravan recalled");
    await replyToCommand(ctx, evt, player, "Your caravan packs up and starts for home — it arrives in ~3m.");
  }

  return {
    name: "caravan",
    consumes: ["caravan.recall.requested", "trade.completed"],
    actions: {
      /**
       * `/caravan send <destination>` — post a caravan abroad. Guards are the
       * FIRST TWO §2.3 gates only (research + Trade Post): requiring an agent on
       * site to send an agent would be circular.
       *
       * Replies then throws on a rejection, so the workflow's on_error routes to
       * a bare final state without arming the travel timer — the same shape
       * wayfare.depart and dispatch.request use.
       */
      "caravan.send": async (_args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        const destination = payloadString(evt, "destination");
        const homeGuildId = ctx.personas.homeGuild(evt?.guildId);
        await ensurePlayer(ctx.sql, player, homeGuildId, DEFAULT_STARTING_GOLD);

        if (!destination || !continents.continents[destination]) {
          await publishReply(ctx, "caravan.rejected", evt, player, "No such shore appears on your charts.");
          throw new Error("invalid destination");
        }
        if (destination === homeGuildId) {
          await publishReply(ctx, "caravan.rejected", evt, player, "You're standing in that market already — no caravan needed.");
          throw new Error("destination is home");
        }
        // §2.3's first two gates ONLY. The full guard also demands an agent on
        // site, which a caravan is — asking for one here would mean no player
        // could ever send their first.
        const block = await tradeRoutesAndPostBlock(ctx.sql, player, destination);
        if (block) {
          await publishReply(ctx, "caravan.rejected", evt, player, block);
          throw new Error("cross-continent commerce blocked");
        }
        const [existing] = await ctx.sql<{ id: string }[]>`
          SELECT id FROM dispatches
          WHERE owner_id = ${player} AND status <> 'done' AND mission->>'kind' = ${CARAVAN_MISSION}
            AND mission->>'destination_guild_id' = ${destination} LIMIT 1
        `;
        if (existing) {
          await publishReply(ctx, "caravan.rejected", evt, player, "You already have a caravan on that road.");
          throw new Error("caravan already sent");
        }
        // One idle troop stack rides as escort — §2.6's troops are the general
        // "send someone" mechanic. The SMALLEST stack is taken so posting a trade
        // route never quietly conscripts the player's whole army.
        const [escort] = await ctx.sql<{ id: string; qty: number; unit_type: string }[]>`
          SELECT id, qty, unit_type FROM units
          WHERE owner_id = ${player} AND kind = 'troop' AND status = 'idle' AND qty > 0
          ORDER BY qty ASC, id ASC LIMIT 1
        `;
        if (!escort) {
          await publishReply(ctx, "caravan.rejected", evt, player, "No troops stand idle to escort a caravan — muster some first.");
          throw new Error("no escort available");
        }

        const dispatchId = `dsp_${ulid()}`;
        const arrivesAt = new Date(Date.now() + CARAVAN_TRAVEL_MS);
        await ctx.sql`
          INSERT INTO dispatches (id, owner_id, mission, force, origin_guild_id, status, arrives_at, correlation_id)
          VALUES (${dispatchId}, ${player},
                  ${jsonParam(ctx.sql, { kind: CARAVAN_MISSION, destination_guild_id: destination })},
                  ${jsonParam(ctx.sql, { champion: null, troops: [{ unitId: escort.id, unitType: escort.unit_type, qty: escort.qty }] })},
                  ${homeGuildId}, 'travelling', ${arrivesAt.toISOString()}, ${evt?.correlationId ?? null})
        `;
        await ctx.sql`UPDATE units SET status = 'dispatched' WHERE id = ANY(${[escort.id]})`;

        ctx.logger.info({ player, dispatchId, destination }, "caravan sent");
        await ctx.bus.publish({
          type: "caravan.sent",
          guildId: evt?.guildId ?? null,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: {
            dispatch_id: dispatchId,
            destination,
            message: `Your caravan sets out for **${continentName(destination)}** — it arrives in ~3m.`,
          },
          correlationId: evt?.correlationId ?? null,
        });
      },

      /**
       * Tick's dispatch.arrived: the caravan takes up its post. The conditional
       * travelling→stationed claim is the exactly-once gate (a redelivered tick
       * finds no row), and pins the mission kind so this never seizes a battle.
       */
      "caravan.arrive": async (_args, evt, ctx: CapabilityContext) => {
        const dispatchId = payloadString(evt, "dispatch_id");
        if (!dispatchId) return;
        const [row] = await ctx.sql<DispatchRow[]>`
          UPDATE dispatches SET status = 'stationed'
          WHERE id = ${dispatchId} AND status = 'travelling' AND mission->>'kind' = ${CARAVAN_MISSION}
          RETURNING id, owner_id, mission, origin_guild_id, status
        `;
        if (!row) return;
        await renderStall(ctx, row);
        ctx.logger.info({ dispatchId, destination: row.mission?.destination_guild_id }, "caravan stationed");
        await ctx.bus.publish({
          type: "caravan.stationed",
          guildId: row.origin_guild_id,
          actor: { kind: "player", id: row.owner_id },
          subject: { kind: "npc", id: ctx.bot },
          payload: {
            dispatch_id: dispatchId,
            message: `Your caravan has reached **${continentName(row.mission?.destination_guild_id ?? "")}** and set out its wares in your land.`,
          },
        });
      },

      /** Tick's dispatch.returned: the escort comes home and is free to be sent again. */
      "caravan.return": async (_args, evt, ctx: CapabilityContext) => {
        const dispatchId = payloadString(evt, "dispatch_id");
        if (!dispatchId) return;
        const returned = await returnDispatch(ctx.sql, dispatchId, CARAVAN_MISSION);
        if (!returned) return;
        ctx.logger.info({ dispatchId, units: returned.unitIds.length }, "caravan returned");
        await ctx.bus.publish({
          type: "notify.requested",
          guildId: evt?.guildId ?? null,
          actor: { kind: "player", id: returned.ownerId },
          subject: { kind: "npc", id: ctx.bot },
          payload: { message: "Your caravan is home, its escort stood down." },
        });
      },
    },

    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      if (evt.type === "caravan.recall.requested") {
        if (notForMe(evt, ctx.bot)) return;
        await recallCaravan(evt, ctx);
        return;
      }
      // A sale moved the source merchant's stock, so every posted stall showing
      // it is now stale. Not addressed to this bot (the merchant sold it), so
      // notForMe deliberately does NOT gate here.
      //
      // Since §2.5 the seller is continent-qualified (`merchant@<guild>`), so
      // match any of the merchant's faces rather than its bare id.
      if (evt.type === "trade.completed") {
        const npcId = await sourceNpc(ctx.sql);
        if (!npcId || !isOwnNpc(evt.subject?.id, npcId)) return;
        const posted = await ctx.sql<DispatchRow[]>`
          SELECT id, owner_id, mission, origin_guild_id, status FROM dispatches
          WHERE status = 'stationed' AND mission->>'kind' = ${CARAVAN_MISSION}
        `;
        for (const dispatch of posted) await renderStall(ctx, dispatch);
      }
    },

    init(ctx: CapabilityContext): void {
      // Registered synchronously (before any await) so a click is never dropped
      // mid-boot — the same rule `market` follows.
      ctx.gateway.onComponent(async (interaction) => {
        const match = CUSTOM_ID.exec(interaction.customId);
        if (!match) return;
        const [, dispatchId, itemId] = match;
        await buyFromCaravan(interaction, dispatchId!, itemId!, ctx);
      });
    },
  };
}
