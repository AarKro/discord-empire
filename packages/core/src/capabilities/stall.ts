/**
 * stall (framework spec §5.3) — public shop presence. A pinned embed in the
 * location text chat with an Enter-the-stall button, opened/closed with the
 * NPC's arrival/departure and refreshed on stock/price changes.
 *
 * Stock/prices are content (validated Shop schema) + ledger-derived inventory;
 * this capability only renders and routes the Enter button into dialogue.
 */
import type { Shop } from "@empire/content-schemas";
import type { Capability, CapabilityContext } from "../capability.js";
import { stallEmbed, buttonRow } from "../ui-kit.js";
import type { Sql } from "@empire/db";

export const ENTER_STALL_BUTTON = "stall:enter";

/** Live stock for an NPC's shop, from the ledger-derived inventory cache. */
async function liveItems(sql: Sql, npcId: string, shop: Shop) {
  const rows = await sql<{ item_id: string; qty: number }[]>`
    SELECT item_id, qty FROM inventories WHERE owner_kind = 'npc' AND owner_id = ${npcId}
  `;
  const stockById = new Map(rows.map((row) => [row.item_id, row.qty]));
  return shop.items.map((item) => ({
    name: item.name,
    price: item.base_price,
    stock: stockById.get(item.item_id) ?? item.stock,
  }));
}

export function stallCapability(shop: Shop): Capability {
  return {
    name: "stall",
    // Refresh on stock/price/trade changes; open/close on arrival/departure.
    consumes: ["stall.", "trade.completed", "stock.restocked", "npc.arrived", "npc.departed"],
    actions: {
      "stall.open": async (_args, evt, ctx: CapabilityContext) => {
        const guildId = ctx.personas.homeGuild(evt?.guildId);
        const persona = ctx.personas.resolve(guildId);
        const items = await liveItems(ctx.sql, ctx.bot, shop);
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
        await ctx.bus.publish({
          type: "stall.entered",
          guildId: interaction.guildId,
          actor: { kind: "player", id: interaction.userId },
          subject: { kind: "npc", id: ctx.bot },
          payload: { shop: shop.id },
        });
      });
    },
    async handle(evt, ctx) {
      // Open/close with the NPC's own arrival/departure (§5.3).
      if (evt.subject?.id === ctx.bot && evt.type === "npc.arrived") {
        await this.actions["stall.open"]!({}, evt, ctx);
        return;
      }
      if (evt.subject?.id === ctx.bot && evt.type === "npc.departed") {
        await this.actions["stall.close"]!({}, evt, ctx);
        return;
      }
      // Re-render the stall on any stock-affecting event while it is open.
      if (evt.type === "trade.completed" || evt.type === "stock.restocked") {
        const handler = this.actions["stall.open"]!;
        await handler({}, evt, ctx);
      }
    },
  };
}
