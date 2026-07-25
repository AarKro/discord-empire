/**
 * The pinned offer boards on a continent's Marketplace (framework spec §5.11).
 *
 * The Marketplace channel carries two boards — the stall listings (`order`
 * offers) and the Auction House (`auction` offers) — rendered by two different
 * capabilities but built exactly the same way: read that continent's open
 * offers of one kind, lay them out as an embed with one button each, and upsert
 * a pinned message whose id is remembered per continent in the exchange bot's
 * npcs.state.
 *
 * Sharing it puts the two fiddly Discord constraints in ONE place: at most 25
 * offers (the per-message button cap) and at most 5 buttons per action row.
 * Both boards previously carried their own copy of that arithmetic.
 */
import type { EmbedBuilder } from "discord.js";
import type { CapabilityContext } from "../runtime/capability.js";
import { locationChannel } from "../world/locations.js";
import { readNpcState, upsertNpcStateEntry } from "../world/npc-state.js";
import { buttonRow } from "../ui/kit.js";

/**
 * A row of the `offers` table as the boards read it. `side` is only meaningful
 * for direct/stall offers; auctions are always a sell.
 */
export interface OfferRow {
  id: string;
  kind: string;
  maker_id: string;
  taker_id: string | null;
  item_id: string;
  qty: number;
  price: number;
  side?: string;
  status: string;
  guild_id: string | null;
  expires_at: string | null;
}

/** Discord's per-message limits: 5 action rows × 5 buttons. */
const BUTTONS_PER_ROW = 5;
const MAX_OFFERS = BUTTONS_PER_ROW * 5;

export interface OfferBoard {
  /** Which offers this board shows. */
  kind: "order" | "auction";
  /** The npcs.state map holding this board's message id per continent. */
  stateKey: string;
  /** Render the board's embed from the offers on show. */
  embed: (offers: OfferRow[]) => EmbedBuilder;
  /** The button that acts on one offer (Buy / Place Bid). */
  button: (offer: OfferRow) => { id: string; label: string };
}

/**
 * Re-render one continent's board. A missing Marketplace channel is a
 * world:init gap, not an error — it logs and leaves the board alone.
 */
export async function renderOfferBoard(
  ctx: CapabilityContext,
  guildId: string,
  board: OfferBoard,
): Promise<void> {
  const channelId = await locationChannel(ctx.sql, guildId, "market");
  if (!channelId) {
    ctx.logger.warn({ guildId, board: board.kind }, "no Marketplace channel — run world:init");
    return;
  }
  const offers = await ctx.sql<OfferRow[]>`
    SELECT * FROM offers
     WHERE kind = ${board.kind} AND status = 'open' AND guild_id = ${guildId}
     ORDER BY id LIMIT ${MAX_OFFERS}
  `;
  const rows: unknown[] = [];
  for (let i = 0; i < offers.length; i += BUTTONS_PER_ROW) {
    rows.push(buttonRow(offers.slice(i, i + BUTTONS_PER_ROW).map(board.button)).toJSON());
  }
  const state = await readNpcState<Record<string, Record<string, string> | undefined>>(ctx.sql, ctx.bot);
  const known = state[board.stateKey]?.[guildId] ?? null;
  const messageId = await ctx.gateway.upsertPinnedMessage(channelId, known, {
    embeds: [board.embed(offers).toJSON()],
    components: rows as never[],
  });
  if (messageId) await upsertNpcStateEntry(ctx.sql, ctx.bot, board.stateKey, guildId, messageId);
}
