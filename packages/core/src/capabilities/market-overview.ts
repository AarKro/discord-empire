/**
 * The `/market` overview (framework spec §5.11) — the exchange bot's READ view.
 *
 * Split from the market capability because it shares nothing with it but the
 * `offers` table: no buttons, no bus events, no writes. It answers one ephemeral
 * command straight from the DB, so it lives beside the capability rather than
 * inside it, and the capability is left holding only the paths that mutate.
 */
import type { Sql } from "@empire/db";
import type { Continents } from "@empire/content-schemas";
import type { EmbedBuilder } from "discord.js";
import { marketOverviewEmbed, type MarketOverview } from "../ui-kit.js";
import type { OfferRow } from "./offer-board.js";

/** Max lines per continent in the `/market` browse before we truncate + count. */
const BROWSE_CAP = 12;

/** Minutes-until-close suffix for a timed auction (empty for stalls / no expiry). */
function closesIn(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const mins = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60_000);
  return mins <= 0 ? " · closing" : ` · closes ${mins}m`;
}

/**
 * Render the ephemeral `/market` overview (§5.11) for one player: their own open
 * positions (stalls, auctions they listed, and auctions where their gold is the
 * current high bid) plus a cross-continent browse of everyone *else's* open
 * listings, grouped by continent. A pure read — buying/bidding still route
 * through the board buttons. Returns the embed for the direct-command reply.
 */
export async function buildMarketOverviewEmbed(sql: Sql, continents: Continents, userId: string): Promise<EmbedBuilder> {
  const continentName = (guildId: string | null): string =>
    (guildId && continents.continents[guildId]?.name) || "a distant shore";

  // The caller's own open stalls + auctions they listed.
  const mine = await sql<OfferRow[]>`
    SELECT * FROM offers
     WHERE maker_id = ${userId} AND status = 'open' AND kind IN ('order', 'auction')
     ORDER BY kind, id
  `;
  // Auctions where the caller is the current high bidder (their gold is escrowed).
  const bids = await sql<OfferRow[]>`
    SELECT * FROM offers
     WHERE kind = 'auction' AND status = 'open' AND taker_id = ${userId}
     ORDER BY expires_at NULLS LAST, id
  `;
  // Everyone else's open listings, across all continents.
  const others = await sql<OfferRow[]>`
    SELECT * FROM offers
     WHERE status = 'open' AND kind IN ('order', 'auction') AND maker_id <> ${userId}
     ORDER BY guild_id, kind, id
  `;

  const positions: string[] = [];
  for (const o of mine) {
    const where = ` [${continentName(o.guild_id)}]`;
    if (o.kind === "order") {
      positions.push(`Stall · ${o.qty}× ${o.item_id} @ ${o.price}g${where}`);
    } else {
      const bid = o.taker_id ? `high ${o.price}g` : `starting ${o.price}g`;
      positions.push(`Auction · ${o.qty}× ${o.item_id} — ${bid}${closesIn(o.expires_at)}${where}`);
    }
  }
  for (const o of bids) {
    positions.push(`Bid · ${o.item_id} — your ${o.price}g escrowed (high)${closesIn(o.expires_at)} [${continentName(o.guild_id)}]`);
  }

  const line = (o: OfferRow): string =>
    o.kind === "order"
      ? `Stall · ${o.qty}× ${o.item_id} @ ${o.price}g`
      : `Auction · ${o.qty}× ${o.item_id} — ${o.taker_id ? `high ${o.price}g` : `starting ${o.price}g`}${closesIn(o.expires_at)}`;

  // Group others' listings by continent, in continent order; cap + count overflow.
  const browse: MarketOverview["browse"] = [];
  const ordered = Object.entries(continents.continents).sort((a, b) => a[1].order - b[1].order);
  for (const [guildId, meta] of ordered) {
    const rows = others.filter((o) => o.guild_id === guildId);
    if (rows.length === 0) continue;
    const lines = rows.slice(0, BROWSE_CAP).map(line);
    if (rows.length > BROWSE_CAP) lines.push(`…and ${rows.length - BROWSE_CAP} more`);
    browse.push({ continent: meta.name, lines });
  }

  return marketOverviewEmbed({ positions, browse });
}
