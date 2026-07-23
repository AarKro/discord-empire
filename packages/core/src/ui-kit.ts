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
