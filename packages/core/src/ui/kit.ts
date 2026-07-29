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
  /** A ware from another continent (§2.5) — marked so the premium reads as fiction. */
  imported?: boolean;
}

/** The stall's pinned embed (§5.3): wares, prices, an Enter-the-stall button. */
export function stallEmbed(title: string, items: StallEmbedItem[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(title);
  if (items.length === 0) {
    embed.setDescription("_The stall is closed._");
  } else {
    embed.setDescription(
      items
        .map((item) => {
          // An import is dear and scarce by design (§2.5). Saying WHY on the line
          // keeps it reading as a curio the merchant hauled back rather than a
          // pricing bug — and it advertises what a caravan would actually get you.
          if (item.imported) return `✦ **${item.name}** — ${item.price} gold _(from my own travels — only ${item.stock} left)_`;
          return `**${item.name}** — ${item.price} gold ${item.stock <= 2 ? `(only ${item.stock} left!)` : ""}`;
        })
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

export interface BattleLogEmbed {
  /** The encounter's display name. */
  encounter: string;
  outcome: "victory" | "defeat";
  /** What was sent, pre-formatted (e.g. "6× infantry", "Champion (lvl 3)"). */
  force: string[];
  /** One pre-formatted line per round, in order. */
  rounds: string[];
  /** What the loot roll actually awarded, pre-formatted; empty on a loss. */
  loot: string[];
  /** The battle's seed — printed so a player can audit the fight (§5.13). */
  seed: string;
}

/**
 * The solo-fight resolution log (§2.6): the whole delivery surface of a combat.
 * §2.6 makes the fight auto-resolve while the player is away, so this embed is
 * the *only* thing they see of it — hence the round-by-round log rather than a
 * verdict, and hence the seed in the footer: the fight is replayable, and
 * saying so in the UI is what makes "auditable" a player-facing promise rather
 * than an internal one.
 */
export function battleLogEmbed(b: BattleLogEmbed): EmbedBuilder {
  const won = b.outcome === "victory";
  const embed = new EmbedBuilder()
    .setTitle(`${won ? "Victory" : "Defeat"} — ${b.encounter}`)
    .setColor(won ? 0x4c9f70 : 0x9f4c4c)
    .addFields(
      { name: "Force dispatched", value: fieldValue(b.force) },
      { name: "Resolution", value: fieldValue(b.rounds) },
      // A loss costs only the loot chance (§2.6) — say so plainly rather than
      // showing an empty field the player has to interpret.
      { name: "Spoils", value: won ? fieldValue(b.loot) : "_The field was lost; no spoils taken._" },
    )
    .setFooter({ text: `seed ${b.seed}` });
  return embed;
}

export interface ModalFieldSpec {
  id: string;
  label: string;
  placeholder?: string | undefined;
  /** Discord enforces this client-side; callers must still re-check on submit. */
  maxLength?: number | undefined;
  paragraph?: boolean | undefined;
}

export function modal(id: string, title: string, fields: ModalFieldSpec[]): ModalBuilder {
  const builder = new ModalBuilder().setCustomId(id).setTitle(title);
  for (const field of fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label)
      .setStyle(field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    if (field.maxLength) input.setMaxLength(field.maxLength);
    builder.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  return builder;
}

export const ui = { buttonRow, selectMenu, stallEmbed, auctionEmbed, battleLogEmbed, modal };
