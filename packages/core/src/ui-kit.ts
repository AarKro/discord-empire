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
  for (const b of buttons) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(b.id)
        .setLabel(b.label)
        .setStyle(ButtonStyle[b.style ?? "Primary"])
        .setDisabled(b.disabled ?? false),
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
        .map((i) => `**${i.name}** — ${i.price} gold ${i.stock <= 2 ? `(only ${i.stock} left!)` : ""}`)
        .join("\n"),
    );
  }
  return embed;
}

export function modal(id: string, title: string, fields: { id: string; label: string }[]): ModalBuilder {
  const m = new ModalBuilder().setCustomId(id).setTitle(title);
  for (const f of fields) {
    m.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(TextInputStyle.Short),
      ),
    );
  }
  return m;
}

export const ui = { buttonRow, selectMenu, stallEmbed, modal };
