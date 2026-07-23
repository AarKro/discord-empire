/**
 * auction (framework spec §5.11) — timed player auctions on the Marketplace.
 * A lister opens an auction; players bid via a "Place Bid" button → modal; the
 * highest bid at close wins. Only the exchange bot runs this capability, so
 * button/modal interactions arrive on its own gateway and route straight back.
 *
 * Escrow (Aaron's call: hold-on-bid, honest auction) reuses executeTrade so gold
 * only ever moves through a vetted atomic writer (invariant #2):
 *   - the LISTED ITEM is escrowed to the auction Party `auction:<offerId>` at
 *     listing (a price-0 trade) so it can't be sold elsewhere;
 *   - each BID escrows the bidder's gold by "buying" a hidden `auction_bid` token
 *     from the auction Party (mirrors the build_permit gold-sink) — this also
 *     gives the insufficient-funds guard for free;
 *   - being outbid reverses that trade (refund); the CLOSE is settled atomically
 *     by @empire/db's settleAuction (item→winner, gold→lister, or item back).
 *
 * The current high bid lives on the offers row (`price` = high bid, `taker_id` =
 * high bidder); the `bids` table is the auditable history. On the offers row an
 * auction's `price` starts at the reserve (starting price).
 */
import { executeTrade, settleAuction, type Sql } from "@empire/db";
import type { Capability, CapabilityContext } from "../capability.js";
import type { BusEvent } from "../bus.js";
import type { ModalSubmitInteraction } from "../gateway.js";
import { auctionEmbed, buttonRow, modal } from "../ui-kit.js";
import { notForMe, payloadString } from "../events.js";
import { locationChannel } from "../locations.js";
import { readNpcState, upsertNpcStateEntry } from "../npc-state.js";
import { ulid } from "ulid";

/** The hidden token whose "sale" escrows a bidder's gold (mirrors BUILD_PERMIT_ITEM). */
const HOLD_TOKEN = "auction_bid";
/** Seed the auction Party with plenty so a bid's escrow trade always has stock. */
const TOKEN_STOCK = 1_000_000;
/** The Place Bid button + its modal share this custom id: `auc:bid:<offerId>`. */
const BID_ID = /^auc:bid:(.+)$/;
const BID_FIELD = "amount";

interface OfferRow {
  id: string;
  kind: string;
  maker_id: string;
  taker_id: string | null;
  item_id: string;
  qty: number;
  price: number;
  status: string;
  guild_id: string | null;
  expires_at: string | null;
}

export function auctionCapability(): Capability {
  async function landChannelFor(sql: Sql, playerId: string): Promise<string | null> {
    const [plot] = await sql<{ text_channel_id: string | null }[]>`
      SELECT text_channel_id FROM land_plots WHERE owner_id = ${playerId} AND pruned = false LIMIT 1
    `;
    return plot?.text_channel_id ?? null;
  }

  /** Resolve the ephemeral reply for a slash command (generic command.reply). */
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

  /** A player's current continent (where their auction lists / renders). */
  async function currentGuild(sql: Sql, playerId: string, fallback: string | null): Promise<string | null> {
    const [row] = await sql<{ position_guild_id: string | null }[]>`SELECT position_guild_id FROM players WHERE discord_user_id = ${playerId}`;
    return row?.position_guild_id ?? fallback;
  }

  /**
   * Re-render a continent's Auction House board: ONE embed of that guild's open
   * auctions with a Place Bid button each (Discord's 25-button cap). Shares the
   * Marketplace channel with the stall board but is tracked SEPARATELY in the
   * exchange bot's npcs.state.auction_boards[guild].
   */
  async function renderBoard(ctx: CapabilityContext, guildId: string): Promise<void> {
    const channelId = await locationChannel(ctx.sql, guildId, "market");
    if (!channelId) {
      ctx.logger.warn({ guildId }, "no Marketplace channel — run world:init");
      return;
    }
    const offers = await ctx.sql<OfferRow[]>`
      SELECT * FROM offers WHERE kind = 'auction' AND status = 'open' AND guild_id = ${guildId} ORDER BY id LIMIT 25
    `;
    const embed = auctionEmbed(
      "Auction House",
      offers.map((o) => ({ name: `${o.qty}× ${o.item_id}`, bid: o.price, hasBid: o.taker_id != null })),
    );
    const rows: unknown[] = [];
    for (let i = 0; i < offers.length; i += 5) {
      rows.push(buttonRow(offers.slice(i, i + 5).map((o) => ({ id: `auc:bid:${o.id}`, label: `Bid on ${o.item_id}` }))).toJSON());
    }
    const state = await readNpcState<{ auction_boards?: Record<string, string> }>(ctx.sql, ctx.bot);
    const messageId = await ctx.gateway.upsertPinnedMessage(channelId, state.auction_boards?.[guildId] ?? null, { embeds: [embed.toJSON()], components: rows as never[] });
    if (messageId) await upsertNpcStateEntry(ctx.sql, ctx.bot, "auction_boards", guildId, messageId);
  }

  /** /auction <item> <qty> <starting_price> <duration> — open a timed auction. */
  async function listAuction(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
    const seller = evt.actor?.id;
    if (!seller) return;
    const item = payloadString(evt, "item");
    const qty = Math.max(1, Number(payloadString(evt, "qty", "1")) || 1);
    const startingPrice = Number(payloadString(evt, "starting_price", "0")) || 0;
    const duration = Number(payloadString(evt, "duration", "0")) || 0;
    if (!item || startingPrice <= 0 || duration <= 0) {
      await reply(ctx, evt, seller, "Name a real ware, a starting price, and how many minutes it runs.");
      return;
    }
    const [held] = await ctx.sql<{ qty: number }[]>`SELECT qty FROM inventories WHERE owner_kind = 'player' AND owner_id = ${seller} AND item_id = ${item}`;
    if ((held?.qty ?? 0) < qty) {
      await reply(ctx, evt, seller, `You don't have ${qty}× ${item} to auction.`);
      return;
    }
    const guildId = await currentGuild(ctx.sql, seller, evt.guildId ?? null);
    if (!guildId) {
      await reply(ctx, evt, seller, "You must be somewhere to open an auction.");
      return;
    }

    const offerId = `off_${ulid()}`;
    // Seed the auction Party BEFORE escrowing: a (zero) gold balance row so the
    // price-0 listing escrow's buyer-debit passes, and token stock so bids can
    // "buy" the hidden hold-token.
    await ctx.sql`INSERT INTO balances (owner_kind, owner_id, currency, amount) VALUES ('auction', ${offerId}, 'gold', 0) ON CONFLICT DO NOTHING`;
    await ctx.sql`INSERT INTO inventories (owner_kind, owner_id, item_id, qty) VALUES ('auction', ${offerId}, ${HOLD_TOKEN}, ${TOKEN_STOCK}) ON CONFLICT DO NOTHING`;

    // Escrow the listed item into the auction Party (price 0 = pure item move).
    const escrow = await executeTrade(ctx.sql, {
      eventId: `evt_${ulid()}`,
      buyer: { kind: "auction", id: offerId },
      seller: { kind: "player", id: seller },
      itemId: item,
      qty,
      price: 0,
      guildId,
      reason: "auction_escrow",
    });
    if (!escrow.ok) {
      // Nothing listed yet — drop the seeded escrow rows and bail.
      await ctx.sql`DELETE FROM balances WHERE owner_kind = 'auction' AND owner_id = ${offerId}`;
      await ctx.sql`DELETE FROM inventories WHERE owner_kind = 'auction' AND owner_id = ${offerId}`;
      await reply(ctx, evt, seller, `You don't have ${qty}× ${item} to auction.`);
      return;
    }

    const expiresAt = new Date(Date.now() + duration * 60_000).toISOString();
    await ctx.sql`
      INSERT INTO offers (id, kind, maker_kind, maker_id, item_id, qty, price, side, status, guild_id, expires_at)
      VALUES (${offerId}, 'auction', 'player', ${seller}, ${item}, ${qty}, ${startingPrice}, 'sell', 'open', ${guildId}, ${expiresAt})
    `;
    await renderBoard(ctx, guildId);
    await reply(ctx, evt, seller, `Auction opened: **${qty}× ${item}**, starting at **${startingPrice} gold**, for ${duration} min.`);
  }

  /** Place Bid modal submitted → validate, escrow, refund prior high, claim high. */
  async function placeBid(modalSubmit: ModalSubmitInteraction, offerId: string, ctx: CapabilityContext): Promise<void> {
    const bidder = modalSubmit.userId;
    const [offer] = await ctx.sql<OfferRow[]>`SELECT * FROM offers WHERE id = ${offerId}`;
    if (!offer || offer.kind !== "auction" || offer.status !== "open") {
      await modalSubmit.reply("That auction has closed.");
      return;
    }
    if (offer.expires_at && new Date(offer.expires_at).getTime() < Date.now()) {
      await modalSubmit.reply("That auction has ended.");
      return;
    }
    if (offer.maker_id === bidder) {
      await modalSubmit.reply("You can't bid on your own auction.");
      return;
    }
    const amount = Number(modalSubmit.fields[BID_FIELD]);
    if (!Number.isInteger(amount) || amount <= 0) {
      await modalSubmit.reply("Enter your bid as a whole number of gold.");
      return;
    }
    // First bid must meet the reserve (starting price); later bids must beat the
    // current high. `price` holds the reserve until taker_id is set.
    const required = offer.taker_id ? offer.price + 1 : offer.price;
    if (amount < required) {
      await modalSubmit.reply(`Your bid must be at least ${required} gold.`);
      return;
    }

    // Escrow the bid: the auction Party "sells" a hidden hold-token for `amount`,
    // moving the bidder's gold into escrow (and guarding funds atomically).
    const escrow = await executeTrade(ctx.sql, {
      eventId: `evt_${ulid()}`,
      buyer: { kind: "player", id: bidder },
      seller: { kind: "auction", id: offerId },
      itemId: HOLD_TOKEN,
      qty: 1,
      price: amount,
      guildId: offer.guild_id,
      reason: "auction_bid",
    });
    if (!escrow.ok) {
      await modalSubmit.reply(escrow.reason === "insufficient_funds" ? `You don't have ${amount} gold to bid.` : "That bid couldn't be placed.");
      return;
    }

    // Claim the high bid optimistically: `price` is the version token (bids are
    // strictly increasing). If another bid landed first, we lost the race — undo
    // our escrow and ask them to try again.
    const claimed = await ctx.sql`
      UPDATE offers SET price = ${amount}, taker_id = ${bidder}
      WHERE id = ${offerId} AND status = 'open' AND price = ${offer.price}
        AND taker_id IS NOT DISTINCT FROM ${offer.taker_id}
    `;
    if (claimed.count === 0) {
      await refund(ctx, offerId, bidder, amount, offer.guild_id);
      await modalSubmit.reply("You were just outbid — try again.");
      return;
    }

    // Refund the previous high bidder (their escrow reverses) and record ours.
    if (offer.taker_id) {
      await refund(ctx, offerId, offer.taker_id, offer.price, offer.guild_id);
      await ctx.sql`UPDATE bids SET status = 'refunded' WHERE offer_id = ${offerId} AND bidder_id = ${offer.taker_id} AND status = 'held'`;
      const outbidLand = await landChannelFor(ctx.sql, offer.taker_id);
      if (outbidLand) {
        await ctx.gateway.sendToChannel(outbidLand, { content: `You've been outbid on **${offer.item_id}** — your ${offer.price} gold is refunded.` });
      }
    }
    await ctx.sql`INSERT INTO bids (id, offer_id, bidder_id, amount, status) VALUES (${`bid_${ulid()}`}, ${offerId}, ${bidder}, ${amount}, 'held')`;
    if (offer.guild_id) await renderBoard(ctx, offer.guild_id);
    await modalSubmit.reply(`Bid placed: **${amount} gold**. You're the high bidder on ${offer.item_id}.`);
  }

  /** Reverse a bid's escrow (auction buys the hold-token back), refunding the gold. */
  async function refund(ctx: CapabilityContext, offerId: string, playerId: string, amount: number, guildId: string | null): Promise<void> {
    const res = await executeTrade(ctx.sql, {
      eventId: `evt_${ulid()}`,
      buyer: { kind: "auction", id: offerId },
      seller: { kind: "player", id: playerId },
      itemId: HOLD_TOKEN,
      qty: 1,
      price: amount,
      guildId,
      reason: "auction_refund",
    });
    if (!res.ok) ctx.logger.error({ offerId, playerId, amount, reason: res.reason }, "auction refund failed");
  }

  /** tick-service fired auction.closed → settle atomically + announce + refresh. */
  async function settleClosed(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
    const offerId = payloadString(evt, "offer_id");
    if (!offerId) return;
    // Load parties/guild BEFORE the close flips the row (settleAuction is the
    // authority; this read is only for messaging + the board refresh).
    const [offer] = await ctx.sql<OfferRow[]>`SELECT * FROM offers WHERE id = ${offerId}`;
    if (!offer) return;

    const res = await settleAuction(ctx.sql, { offerId, eventId: `evt_${ulid()}`, correlationId: evt.correlationId ?? null });
    if (!res.ok) return; // already settled (idempotent against tick re-fire)

    if (res.outcome === "won" && offer.taker_id) {
      const winnerLand = await landChannelFor(ctx.sql, offer.taker_id);
      if (winnerLand) await ctx.gateway.sendToChannel(winnerLand, { content: `You won the auction for **${offer.qty}× ${offer.item_id}** at **${offer.price} gold**!` });
      const listerLand = await landChannelFor(ctx.sql, offer.maker_id);
      if (listerLand) await ctx.gateway.sendToChannel(listerLand, { content: `Your **${offer.item_id}** sold at auction for **${offer.price} gold**.` });
    } else if (res.outcome === "unsold") {
      const listerLand = await landChannelFor(ctx.sql, offer.maker_id);
      if (listerLand) await ctx.gateway.sendToChannel(listerLand, { content: `Your auction for **${offer.item_id}** ended with no bids — it's back in your pack.` });
    }
    if (offer.guild_id) await renderBoard(ctx, offer.guild_id);
  }

  return {
    name: "auction",
    consumes: ["auction.list.requested", "auction.closed"],
    actions: {},

    async handle(evt: BusEvent, ctx: CapabilityContext): Promise<void> {
      if (notForMe(evt, ctx.bot)) return;
      if (evt.type === "auction.list.requested") await listAuction(evt, ctx);
      else if (evt.type === "auction.closed") await settleClosed(evt, ctx);
    },

    async init(ctx: CapabilityContext): Promise<void> {
      // Register the Place Bid button→modal opener and the modal-submit router
      // synchronously (before any await) so an interaction is never dropped mid-boot.
      ctx.gateway.onModalRequest({
        matches: (id) => BID_ID.test(id),
        build: (id) => modal(id, "Place Bid", [{ id: BID_FIELD, label: "Bid amount (gold)" }]),
      });
      ctx.gateway.onModalSubmit(async (submitted) => {
        const match = BID_ID.exec(submitted.customId);
        if (!match) return;
        await placeBid(submitted, match[1]!, ctx);
      });
      await ctx.sql`INSERT INTO npcs (id, kind) VALUES (${ctx.bot}, 'exchange') ON CONFLICT DO NOTHING`;
    },
  };
}
