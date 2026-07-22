/**
 * stall (framework spec §5.3) — public shop presence. A pinned embed in the
 * location text chat with an Enter-the-stall button. The NPC's workflow opens and
 * closes it (composing the stall.open/close verbs); it re-renders on a purchase so
 * the stock reflects the sale.
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
    // Re-render on a purchase (stock changed). Opening/closing the stall is
    // driven by the NPC's workflow (merchant_wander composes stall.open/close).
    consumes: ["trade.completed"],
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
    /** Re-render the open stall after a purchase, so its stock reflects the sale. */
    async handle(evt, ctx) {
      if (evt.type === "trade.completed") {
        await this.actions["stall.open"]!({}, evt, ctx);
      }
    },
  };
}
