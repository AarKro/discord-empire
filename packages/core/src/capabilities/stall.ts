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
import { regionOf, regionalItem } from "../world/goods.js";
import { ensurePlayer, type Sql } from "@empire/db";

export const ENTER_STALL_BUTTON = "stall:enter";

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
