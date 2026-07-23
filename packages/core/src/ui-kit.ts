/**
 * ui.kit (framework spec §5.6) — the shared interaction toolbox. All capabilities
 * build Discord UI through these wrappers, giving one adoption point for a future
 * Components V2 migration. Kept intentionally thin over discord.js builders.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

export interface ButtonSpec {
  id: string;
  label: string;
  style?: keyof typeof ButtonStyle;
  disabled?: boolean;
}

export function buttonRow(buttons: ButtonSpec[]): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const button of buttons) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(button.id)
        .setLabel(button.label)
        .setStyle(ButtonStyle[button.style ?? "Primary"])
        .setDisabled(button.disabled ?? false),
    );
  }
  return row;
}

export function selectMenu(
  id: string,
  options: { label: string; value: string; description?: string }[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder().setCustomId(id).addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export interface StallEmbedItem {
  name: string;
  price: number;
  stock: number;
}

/** The stall's pinned embed (§5.3): wares, prices, an Enter-the-stall button. */
export function stallEmbed(title: string, items: StallEmbedItem[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(title);
  if (items.length === 0) {
    embed.setDescription("_The stall is closed._");
  } else {
    embed.setDescription(
      items
        .map((item) => `**${item.name}** — ${item.price} gold ${item.stock <= 2 ? `(only ${item.stock} left!)` : ""}`)
        .join("\n"),
    );
  }
  return embed;
}

export interface AuctionEmbedItem {
  name: string;
  /** Current high bid, or the starting price when there's no bid yet. */
  bid: number;
  /** Whether a qualifying bid has been placed (vs. still at the reserve). */
  hasBid: boolean;
}

/** The Auction House pinned embed (§5.11): live lots with their current bid. */
export function auctionEmbed(title: string, items: AuctionEmbedItem[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(title);
  if (items.length === 0) {
    embed.setDescription("_No auctions are running._");
  } else {
    embed.setDescription(
      items
        .map((item) => `**${item.name}** — ${item.hasBid ? `current bid ${item.bid}` : `starting at ${item.bid}`} gold`)
        .join("\n"),
    );
  }
  return embed;
}

/** Discord's hard limit on a single embed field's value. */
const FIELD_VALUE_LIMIT = 1024;

/** Join pre-formatted lines into one embed-field value, trimmed to Discord's cap. */
function fieldValue(lines: string[]): string {
  if (lines.length === 0) return "_— none —_";
  const joined = lines.join("\n");
  return joined.length <= FIELD_VALUE_LIMIT ? joined : joined.slice(0, FIELD_VALUE_LIMIT - 1) + "…";
}

export interface MarketOverview {
  /** Pre-formatted lines for the caller's own open positions. */
  positions: string[];
  /** Others' open listings, grouped into one field per continent. */
  browse: { continent: string; lines: string[] }[];
}

/**
 * The ephemeral `/market` overview (§5.11): a "Your positions" field plus one
 * field per continent for browsing everyone else's open stalls & auctions. All
 * line formatting is done by the caller; this only lays out the embed.
 */
export function marketOverviewEmbed(o: MarketOverview): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle("Marketplace");
  embed.addFields({ name: "Your positions", value: fieldValue(o.positions) });
  for (const group of o.browse) {
    embed.addFields({ name: `Browse · ${group.continent}`, value: fieldValue(group.lines) });
  }
  if (o.browse.length === 0) {
    embed.addFields({ name: "Browse", value: "_No open listings anywhere just now._" });
  }
  return embed;
}

export function modal(id: string, title: string, fields: { id: string; label: string }[]): ModalBuilder {
  const builder = new ModalBuilder().setCustomId(id).setTitle(title);
  for (const field of fields) {
    builder.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId(field.id).setLabel(field.label).setStyle(TextInputStyle.Short),
      ),
    );
  }
  return builder;
}

export const ui = { buttonRow, selectMenu, stallEmbed, auctionEmbed, modal };
