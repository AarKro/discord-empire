/**
 * The plain-data shapes a Discord interaction is reduced to before any
 * capability sees it (framework spec §5.6, invariant #4).
 *
 * This is the boundary itself: nothing here imports discord.js values, only its
 * types where a payload passes straight through. Keeping the shapes separate
 * from the client that produces them means a capability's contract can be read
 * without wading through gateway plumbing — and it stays honest, because a
 * discord.js type leaking into a capability would have to be added here first.
 */
import type { MessageCreateOptions, ModalBuilder } from "discord.js";
import type { PersonaResolver } from "../persona.js";
import type { Logger } from "../logger.js";

export interface GatewayOptions {
  token: string;
  botId: string;
  personas: PersonaResolver;
  logger?: Logger;
}

/**
 * A message-component interaction (button/select) reduced to plain data, so
 * capabilities can react to clicks without ever seeing discord.js types.
 */
export interface ComponentInteraction {
  customId: string;
  /** Selected values for select menus; empty for buttons. */
  values: string[];
  userId: string;
  guildId: string | null;
  channelId: string | null;
  /**
   * Send an ephemeral follow-up to this click (e.g. an in-fiction refusal). The
   * click is already acked via deferUpdate, so this is a `followUp`, visible only
   * to the clicker. Safe to skip when the click just proceeds.
   */
  reply: (content: string) => Promise<void>;
  /**
   * Edit the message this component is attached to (e.g. mark an offer settled +
   * drop its buttons). Pass `components: []` to remove the buttons.
   */
  update: (content: MessageCreateOptions) => Promise<void>;
}

export type ComponentHandler = (interaction: ComponentInteraction) => Promise<void> | void;

/**
 * A submitted modal reduced to plain data — field values keyed by their
 * TextInput customId. Unlike a button, a modal submit is NOT auto-acked (there's
 * no spinner), so `reply` defers ephemerally on first use, mirroring slash cmds.
 */
export interface ModalSubmitInteraction {
  customId: string;
  fields: Record<string, string>;
  userId: string;
  guildId: string | null;
  channelId: string | null;
  reply: (content: string) => Promise<void>;
}

export type ModalSubmitHandler = (interaction: ModalSubmitInteraction) => Promise<void> | void;

/** A member joining a guild, reduced to plain data (§9 gatekeeper: reconcile roles at the door). */
export interface MemberJoin {
  guildId: string;
  userId: string;
}
export type MemberJoinHandler = (join: MemberJoin) => Promise<void> | void;

/**
 * A button that opens a modal rather than proceeding. discord.js requires
 * showModal() on a not-yet-acknowledged interaction, so the gateway checks these
 * BEFORE its auto-deferUpdate: a matching button shows the built modal and skips
 * the normal component handlers. `build` runs inside the gateway, so the raw
 * discord.js interaction never leaks to capabilities (invariant #4).
 */
export interface ModalRequest {
  matches: (customId: string) => boolean;
  build: (customId: string, userId: string) => ModalBuilder;
}

/**
 * A plain-data slash-command reply: bare text, or a richer payload carrying an
 * embed (kept as `unknown[]` so no discord.js type leaks to capabilities —
 * invariant #4). A direct command's `resolve` may return either shape.
 */
export interface CommandReply {
  content?: string;
  embeds?: unknown[];
}

/**
 * A slash-command (ChatInput) interaction reduced to plain data. All option
 * values are strings in iteration 1 (§5.10). The discord.js Interaction never
 * leaves the gateway: capabilities only get `reply`, which edits the deferred
 * ephemeral response.
 */
export interface CommandInteraction {
  commandName: string;
  options: Record<string, string>;
  userId: string;
  guildId: string | null;
  channelId: string | null;
  /** Edit the deferred ephemeral reply. Safe to call once; later calls no-op. */
  reply: (response: string | CommandReply) => Promise<void>;
}

export type CommandHandler = (interaction: CommandInteraction) => Promise<void> | void;

/** An autocomplete interaction reduced to plain data (§5.10 game-backed hints). */
export interface AutocompleteInteraction {
  commandName: string;
  /** The option currently being typed. */
  focusedOption: string;
  /** What the player has typed so far (may be empty). */
  value: string;
  userId: string;
  guildId: string | null;
}

/** Returns up to 25 name/value choices; the gateway caps and responds. */
export type AutocompleteHandler = (
  interaction: AutocompleteInteraction,
) => Promise<{ name: string; value: string }[]>;

/**
 * A declarative slash command in the plain shape the gateway registers with
 * Discord (§9 boot registration). `options` values are always strings (iter 1).
 */
export interface CommandRegistration {
  name: string;
  description: string;
  options?: { name: string; description: string; autocomplete?: boolean; required?: boolean }[];
  /**
   * Discord `default_member_permissions` bitfield as a string (§9 Ops bot). When
   * set, only members with those permissions see/run the command — e.g. "8"
   * (Administrator) hides the admin surface from ordinary players.
   */
  defaultMemberPermissions?: string;
}

/**
 * Map CommandRegistration → Discord's application-command REST JSON. Pure and
 * unit-tested; iteration 1 registers every option as a STRING (type 3).
 * Discord command/option types: 1 = CHAT_INPUT command, 3 = STRING option.
 */
export function toApplicationCommandJson(defs: CommandRegistration[]): unknown[] {
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    type: 1,
    ...(def.defaultMemberPermissions !== undefined ? { default_member_permissions: def.defaultMemberPermissions } : {}),
    options: (def.options ?? []).map((option) => ({
      type: 3,
      name: option.name,
      description: option.description,
      required: option.required ?? false,
      autocomplete: option.autocomplete ?? false,
    })),
  }));
}
