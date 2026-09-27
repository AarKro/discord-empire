/**
 * stall (framework spec §5.3) — public shop presence. A pinned embed in the
 * location text chat with an Enter-the-stall button. The NPC's workflow opens and
 * closes it (composing the stall.open/close verbs); it re-renders on a purchase so
 * the stock reflects the sale.
 *
 * Stock/prices are content (validated Shop schema) + ledger-derived inventory;
 * this capability only renders and routes the Enter button into dialogue.
 */
import type { Continents, Shop } from "@empire/content-schemas";
import type { Capability, CapabilityContext } from "../runtime/capability.js";
import { stallEmbed, buttonRow } from "../ui/kit.js";
import { requiresPresence } from "./topology.js";
import { npcAt, isOwnNpc } from "../world/npc-identity.js";
import { buybackPrice, regionOf, regionalItem } from "../world/goods.js";
import { HIDDEN_ITEMS } from "../world/items.js";
import { ensurePlayer, type Sql } from "@empire/db";

export const ENTER_STALL_BUTTON = "stall:enter";

/** Sell-menu buttons: `stall:sell:<item_id>:<qty|all>` (§2.5 buy-back). */
export const SELL_BUTTON_PREFIX = "stall:sell:";

/** Discord allows 5 rows of 5 buttons; two per good, two goods per row. */
const SELL_GOODS_PER_ROW = 2;
const MAX_SELL_GOODS = 10;

/**
 * Live stock for an NPC's shop ON ONE CONTINENT, from the ledger-derived
 * inventory cache. Both halves are regional (§2.5): the purse is `npcAt`'s, and
 * prices come from `regionalItem`, so what a player is shown here is exactly
 * what `trade` will charge them.
 */
async function liveItems(sql: Sql, botId: string, guildId: string, shop: Shop, continents: Continents) {
  const rows = await sql<{ item_id: string; qty: number }[]>`
    SELECT item_id, qty FROM inventories WHERE owner_kind = 'npc' AND owner_id = ${npcAt(botId, guildId)}
  `;
  const stockById = new Map(rows.map((row) => [row.item_id, row.qty]));
  const region = regionOf(continents, guildId);
  return shop.items.map((item) => {
    const regional = regionalItem(item, region);
    return {
      name: item.name,
      price: regional.price,
      stock: stockById.get(item.item_id) ?? regional.stock,
      imported: regional.imported,
    };
  });
}

export function stallCapability(shop: Shop, continents: Continents): Capability {
  return {
    name: "stall",
    // Re-render on a purchase (stock changed). Opening/closing the stall is
    // driven by the NPC's workflow (merchant_wander composes stall.open/close).
    consumes: ["trade.completed", "shop.restocked"],
    actions: {
      "stall.open": async (_args, evt, ctx: CapabilityContext) => {
        const guildId = ctx.personas.homeGuild(evt?.guildId);
        // No persona here means this NPC doesn't exist on that continent, so it
        // has no stall to draw. Checked rather than letting resolve() throw: this
        // runs from a bus handler, where a throw is only ever logged and skipped.
        if (!ctx.personas.has(guildId)) {
          ctx.logger.debug({ guildId }, "no persona on this continent — skipping stall render");
          return;
        }
        const persona = ctx.personas.resolve(guildId);
        const items = await liveItems(ctx.sql, ctx.bot, guildId, shop, continents);
        const embed = stallEmbed(`${persona.nickname}'s Stall`, items);
        const row = buttonRow([{ id: ENTER_STALL_BUTTON, label: "Enter the stall" }]);
        ctx.logger.info({ guildId, items: items.length }, "stall opened");
        // The concrete channel send is wired in the bot process (it holds the
        // resolved location channel); expose the rendered payload via an event.
        await ctx.bus.publish({
          type: "stall.rendered",
          guildId,
          subject: { kind: "npc", id: ctx.bot },
          payload: { embed: embed.toJSON(), components: [row.toJSON()] },
        });
      },
      /**
       * The sell half of the stall conversation (§2.5 buy-back): list what the
       * player holds that this merchant buys, priced for THIS continent, with a
       * Sell 1 / Sell all button per good. Rendered into the player's open
       * dialogue thread by `render`; the clicks come back through init's
       * component handler as sell.request, which `trade` prices and settles.
       */
      "stall.sell_menu": async (_args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        const guildId = evt?.guildId;
        if (!player || !guildId) return;
        const bought = shop.buys.map((b) => b.item_id).filter((id) => !HIDDEN_ITEMS.includes(id));
        const held = await ctx.sql<{ item_id: string; qty: number }[]>`
          SELECT item_id, qty FROM inventories
          WHERE owner_kind = 'player' AND owner_id = ${player} AND qty > 0 AND item_id = ANY(${bought})
          ORDER BY item_id ASC
        `;
        const region = regionOf(continents, guildId);
        const goods = held.slice(0, MAX_SELL_GOODS).flatMap((row) => {
          const good = shop.buys.find((b) => b.item_id === row.item_id);
          if (!good) return [];
          const unit = buybackPrice(good, region);
          return [
            { id: `${SELL_BUTTON_PREFIX}${good.item_id}:1`, label: `Sell 1 ${good.name} (${unit}g)` },
            { id: `${SELL_BUTTON_PREFIX}${good.item_id}:all`, label: `Sell all ${row.qty} (${unit * row.qty}g)` },
          ];
        });
        const rows: { id: string; label: string }[][] = [];
        for (let i = 0; i < goods.length; i += SELL_GOODS_PER_ROW * 2) rows.push(goods.slice(i, i + SELL_GOODS_PER_ROW * 2));
        await ctx.bus.publish({
          type: "sell.menu",
          guildId,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: {
            text: goods.length > 0 ? "Here's what I'll give you:" : "You've nothing I'm buying, I'm afraid.",
            rows,
          },
          correlationId: evt?.correlationId ?? null,
        });
      },
      "stall.close": async (_args, evt, ctx: CapabilityContext) => {
        await ctx.bus.publish({
          type: "stall.closed",
          guildId: evt?.guildId,
          subject: { kind: "npc", id: ctx.bot },
          payload: {},
        });
      },
    },
    /** Route Enter-the-stall clicks into the bus; the dialogue workflow triggers on it. */
    init(ctx: CapabilityContext): void {
      // Sell-menu clicks (§2.5). Presence is re-checked on every click — the
      // menu can outlive the player's stay, and selling is acting (§1.6).
      ctx.gateway.onComponent(async (interaction) => {
        if (!interaction.customId.startsWith(SELL_BUTTON_PREFIX)) return;
        const guildId = interaction.guildId;
        if (!guildId) return;
        const [item, qty] = interaction.customId.slice(SELL_BUTTON_PREFIX.length).split(":");
        if (!item || !qty) return;
        const presence = await requiresPresence(ctx.sql, interaction.userId, `bazaar_${guildId}`);
        if (!presence.present) {
          await interaction.reply(`*${presence.reason ?? "you can't reach this stall from where you stand"}.*`);
          return;
        }
        await ctx.bus.publish({
          type: "sell.request",
          guildId,
          actor: { kind: "player", id: interaction.userId },
          subject: { kind: "npc", id: ctx.bot },
          payload: { item, qty: qty === "all" ? "all" : Number(qty) },
        });
      });
      ctx.gateway.onComponent(async (interaction) => {
        if (interaction.customId !== ENTER_STALL_BUTTON) return;
        const guildId = interaction.guildId;
        if (!guildId) return;
        // Auto-register the shopper (§2.1), then enforce presence (§2.3): you can
        // only step up to the stall on the continent you actually stand on. A
        // player who's travelled away (or is on the road) gets an in-fiction refusal.
        await ensurePlayer(ctx.sql, interaction.userId, guildId);
        const presence = await requiresPresence(ctx.sql, interaction.userId, `bazaar_${guildId}`);
        if (!presence.present) {
          await interaction.reply(`*${presence.reason ?? "you can't reach this stall from where you stand"}.*`);
          return;
        }
        await ctx.bus.publish({
          type: "stall.entered",
          guildId,
          actor: { kind: "player", id: interaction.userId },
          subject: { kind: "npc", id: ctx.bot },
          payload: { shop: shop.id },
        });
      });
    },
    /**
     * Re-render the open stall after a purchase, so its stock reflects the sale.
     * The bus is broadcast: only this NPC's OWN sales change its stock, so an
     * auction escrow, a player-to-player stall buy, or the Builder's permit
     * charge must not drag the pinned embed through a needless Discord edit.
     */
    async handle(evt, ctx) {
      // §3's stock.restocked: a background top-up changed the shelf with nobody
      // trading, so the pinned embed is stale until we redraw it.
      if (evt.type !== "trade.completed" && evt.type !== "shop.restocked") return;
      // Since §2.5, a stall sale's seller — and so this event's subject — is the
      // CONTINENT-QUALIFIED identity (`merchant@<guild>`), not the bare bot id.
      // A plain notForMe(evt, ctx.bot) would no longer recognise the shop's own
      // sales and the pinned embed would quietly stop refreshing its stock.
      // An unaddressed trade still renders, as before.
      if (evt.subject != null && !isOwnNpc(evt.subject.id, ctx.bot)) return;
      await this.actions["stall.open"]!({}, evt, ctx);
    },
  };
}
