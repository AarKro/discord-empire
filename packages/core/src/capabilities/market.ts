/**
 * market (framework spec §5.11) — player-to-player economy. Every deal settles
 * through the SAME atomic executeTrade ledger contract as NPC commerce; the
 * `offers` table holds pending/standing listings. Two forms:
 *   - DIRECT offers to a specific player — contact-gated (§5.11: you must have met
 *     them in a district), confirmed via Accept/Decline buttons posted to their
 *     land channel; quote-style expiry.
 *   - STALL listings (commit 2) — public sell offers rendered on a continent's
 *     Marketplace board with Buy buttons.
 *
 * Only the exchange bot runs this capability; button interactions arrive on its
 * own gateway, so a click routes straight back here.
 */
import { executeTrade, type Party, type Sql } from "@empire/db";
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";
import type { ComponentInteraction } from "../gateway.js";
import { buttonRow } from "../ui-kit.js";
import { notForMe, payloadString } from "../events.js";
import { locationChannel } from "../locations.js";
import { ulid } from "ulid";

/** How long a direct offer stands before it's stale (quote-style expiry, §5.11). */
const OFFER_TTL_MS = 10 * 60_000;
/** Button custom-id scheme: `mkt:<action>:<offerId>`. */
const CUSTOM_ID = /^mkt:(accept|decline|buy):(.+)$/;

interface OfferRow {
  id: string;
  kind: string;
  maker_id: string;
  taker_id: string | null;
  item_id: string;
  qty: number;
  price: number;
  side: string;
  status: string;
  guild_id: string | null;
  expires_at: string | null;
}

export function marketCapability(): Capability {
  /** Two players are contacts iff a symmetric edge exists (stored sorted). */
  async function areContacts(sql: Sql, a: string, b: string): Promise<boolean> {
    const [x, y] = [a, b].sort();
    const rows = await sql`SELECT 1 FROM contacts WHERE player_a = ${x!} AND player_b = ${y!} LIMIT 1`;
    return rows.length > 0;
  }

  async function landChannelFor(sql: Sql, playerId: string): Promise<string | null> {
    const [plot] = await sql<{ text_channel_id: string | null }[]>`
      SELECT text_channel_id FROM land_plots WHERE owner_id = ${playerId} AND pruned = false LIMIT 1
    `;
    return plot?.text_channel_id ?? null;
  }

  /** Resolve the /trade ephemeral reply (generic command.reply the commands cap settles). */
  async function reply(ctx: CapabilityContext, evt: BusEvent, player: string, message: string): Promise<void> {
    await ctx.bus.publish({
      type: "command.reply",
      guildId: evt.guildId ?? null,
      actor: { kind: "player", id: player },
      subject: { kind: "npc", id: ctx.bot },
      payload: { message },
      correlationId: evt.correlationId ?? null,
    });
  }

  /** Buyer/seller for a direct offer, from the proposer's `side` (sell=proposer gives item). */
  function parties(offer: OfferRow): { buyer: Party; seller: Party } {
    const proposer: Party = { kind: "player", id: offer.maker_id };
    const recipient: Party = { kind: "player", id: offer.taker_id! };
    return offer.side === "buy"
      ? { buyer: proposer, seller: recipient } // proposer buys from recipient
      : { buyer: recipient, seller: proposer }; // proposer sells to recipient
  }

  async function createDirectOffer(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
    const proposer = evt.actor?.id;
    if (!proposer) return;
    const recipient = payloadString(evt, "player");
    const side = payloadString(evt, "side") === "buy" ? "buy" : "sell";
    const item = payloadString(evt, "item");
    const qty = Math.max(1, Number(payloadString(evt, "qty", "1")) || 1);
    const price = Number(payloadString(evt, "price", "0")) || 0;

    if (!recipient || recipient === proposer || !item || price <= 0) {
      await reply(ctx, evt, proposer, "That offer doesn't make sense, friend.");
      return;
    }
    if (!(await areContacts(ctx.sql, proposer, recipient))) {
      await reply(ctx, evt, proposer, "You don't know them yet — meet them in a district first.");
      return;
    }

    const offerId = `off_${ulid()}`;
    const expiresAt = new Date(Date.now() + OFFER_TTL_MS).toISOString();
    await ctx.sql`
      INSERT INTO offers (id, kind, maker_kind, maker_id, taker_id, item_id, qty, price, side, status, guild_id, expires_at)
      VALUES (${offerId}, 'direct', 'player', ${proposer}, ${recipient}, ${item}, ${qty}, ${price}, ${side}, 'open', ${evt.guildId ?? null}, ${expiresAt})
    `;

    const verb = side === "buy" ? "wants to buy" : "offers to sell you";
    const content = `<@${recipient}> — <@${proposer}> ${verb} **${qty}× ${item}** for **${price} gold**. _(expires in 10 min)_`;
    const buttons = buttonRow([
      { id: `mkt:accept:${offerId}`, label: "Accept" },
      { id: `mkt:decline:${offerId}`, label: "Decline" },
    ]).toJSON();

    // Deliver to the recipient's land channel, falling back to the Marketplace board.
    const channelId = (await landChannelFor(ctx.sql, recipient)) ?? (evt.guildId ? await locationChannel(ctx.sql, evt.guildId, "market") : null);
    if (!channelId) {
      await reply(ctx, evt, proposer, "They have nowhere to receive it yet — no homestead or marketplace to reach.");
      return;
    }
    await ctx.gateway.sendToChannel(channelId, { content, components: [buttons as never] });
    await reply(ctx, evt, proposer, `Offer sent to <@${recipient}>.`);
  }

  /** Accept/Decline click on a direct offer. */
  async function resolveDirectOffer(interaction: ComponentInteraction, action: string, offerId: string, ctx: CapabilityContext): Promise<void> {
    const clicker = interaction.userId;
    const [offer] = await ctx.sql<OfferRow[]>`SELECT * FROM offers WHERE id = ${offerId}`;
    if (!offer || offer.status !== "open") {
      await interaction.reply("This offer is no longer open.");
      return;
    }
    if (offer.taker_id !== clicker) {
      await interaction.reply("This offer isn't addressed to you.");
      return;
    }

    if (action === "decline") {
      await ctx.sql`UPDATE offers SET status = 'cancelled' WHERE id = ${offerId} AND status = 'open'`;
      await interaction.update({ content: "*Offer declined.*", components: [] });
      return;
    }

    if (offer.expires_at && new Date(offer.expires_at).getTime() < Date.now()) {
      await ctx.sql`UPDATE offers SET status = 'expired' WHERE id = ${offerId} AND status = 'open'`;
      await interaction.update({ content: "*This offer has expired.*", components: [] });
      return;
    }

    // Claim atomically so a double-click can't settle twice; roll back if the trade fails.
    const claimed = await ctx.sql`UPDATE offers SET status = 'filled' WHERE id = ${offerId} AND status = 'open'`;
    if (claimed.count === 0) {
      await interaction.reply("This offer is no longer open.");
      return;
    }

    const { buyer, seller } = parties(offer);
    const result = await executeTrade(ctx.sql, {
      eventId: `evt_${ulid()}`,
      buyer,
      seller,
      itemId: offer.item_id,
      qty: offer.qty,
      price: offer.price,
      guildId: offer.guild_id,
      reason: "player_trade",
    });
    if (!result.ok) {
      await ctx.sql`UPDATE offers SET status = 'open' WHERE id = ${offerId} AND status = 'filled'`;
      await interaction.reply(`The deal fell through: ${result.message ?? result.reason}.`);
      return;
    }

    await interaction.update({ content: `*Deal struck — ${offer.qty}× ${offer.item_id} for ${offer.price} gold.*`, components: [] });
    await interaction.reply("Trade complete — check your purse and packs.");
    // Ping the counterparty (the proposer) in their land channel.
    const proposerLand = await landChannelFor(ctx.sql, offer.maker_id);
    if (proposerLand) {
      await ctx.gateway.sendToChannel(proposerLand, { content: `Your trade with <@${clicker}> settled: **${offer.qty}× ${offer.item_id}** for **${offer.price} gold**.` });
    }
  }

  return {
    name: "market",
    consumes: ["offer.direct.requested"],
    actions: {},

    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      if (evt.type !== "offer.direct.requested" || notForMe(evt, ctx.bot)) return;
      await createDirectOffer(evt, ctx);
    },

    init(ctx: CapabilityContext): void {
      ctx.gateway.onComponent(async (interaction) => {
        const match = CUSTOM_ID.exec(interaction.customId);
        if (!match) return;
        const [, action, offerId] = match;
        if (action === "buy") return; // stall buys land in commit 2
        await resolveDirectOffer(interaction, action!, offerId!, ctx);
      });
    },
  };
}
