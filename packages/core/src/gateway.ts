/**
 * Discord gateway wrapper (framework spec §3, §9). This is the ONLY module that
 * touches discord.js; nothing outside @empire/core imports discord.js directly.
 *
 * Responsibilities: own the Client, centralize outbound calls behind a small
 * queue for rate-limit hygiene (§9), apply per-guild personas idempotently, and
 * join home voice channels self-muted (§4 lifecycle). Voice specifics live in
 * the presence.voice capability, which calls through here.
 */
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type GuildTextBasedChannel,
  type SendableChannels,
  type MessageCreateOptions,
  type MessagePayload,
  type Guild,
  type TextChannel,
} from "discord.js";
import { joinVoiceChannel, type VoiceConnection } from "@discordjs/voice";
import type { PersonaResolver } from "./persona.js";
import type { Logger } from "./logger.js";
import { rootLogger } from "./logger.js";

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
  reply: (content: string) => Promise<void>;
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
    options: (def.options ?? []).map((option) => ({
      type: 3,
      name: option.name,
      description: option.description,
      required: option.required ?? false,
      autocomplete: option.autocomplete ?? false,
    })),
  }));
}

/**
 * A minimal FIFO queue so bursty outbound work (e.g. thirty role grants from one
 * event, §9) is serialized per bot. Capabilities pass cost hints via `weight`.
 */
class CallQueue {
  private chain: Promise<unknown> = Promise.resolve();
  enqueue<T>(fn: () => Promise<T>, _weight = 1): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run as Promise<T>;
  }
}

export class Gateway {
  readonly client: Client;
  readonly queue = new CallQueue();
  private readonly log: Logger;
  private readonly componentHandlers: ComponentHandler[] = [];
  private readonly commandHandlers: CommandHandler[] = [];
  private readonly autocompleteHandlers: AutocompleteHandler[] = [];
  /** guildId → the bot's single voice connection there (one place at a time, §5.1). */
  private readonly voiceConnections = new Map<string, VoiceConnection>();

  constructor(private readonly opts: GatewayOptions) {
    this.log = (opts.logger ?? rootLogger).child({ component: "gateway", bot: opts.botId });
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageTyping, // presence.watch: typingStart
        GatewayIntentBits.MessageContent,
      ],
    });
    // All interactions are reduced to plain data before capabilities see them
    // (invariant #4): buttons/selects, slash commands, and autocomplete.
    this.client.on("interactionCreate", (interaction) => {
      // Button/select clicks: ack immediately (deferUpdate) so Discord never
      // shows a spinner; the visible response arrives via bus-driven renders.
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        void (async () => {
          await interaction.deferUpdate().catch(() => {});
          const reduced: ComponentInteraction = {
            customId: interaction.customId,
            values: interaction.isStringSelectMenu() ? [...interaction.values] : [],
            userId: interaction.user.id,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            reply: (content: string) =>
              this.queue
                .enqueue(async () => {
                  await interaction.followUp({ content, ephemeral: true });
                }, 1)
                .catch((err) => {
                  this.log.warn({ err, customId: interaction.customId }, "failed to send ephemeral follow-up");
                }),
            update: (content: MessageCreateOptions) =>
              this.queue
                .enqueue(async () => {
                  await interaction.editReply(content as Parameters<typeof interaction.editReply>[0]);
                }, 1)
                .catch((err) => {
                  this.log.warn({ err, customId: interaction.customId }, "failed to edit component message");
                }),
          };
          for (const handler of this.componentHandlers) {
            try {
              await handler(reduced);
            } catch (err) {
              this.log.error({ err, customId: reduced.customId }, "component handler failed");
            }
          }
        })();
        return;
      }

      // Slash commands: defer ephemerally at once (the result may arrive later
      // via a bus round-trip), reduce to plain data, hand a `reply` callback
      // that edits the deferred response (the Interaction stays in the gateway).
      if (interaction.isChatInputCommand()) {
        void (async () => {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          const options: Record<string, string> = {};
          for (const opt of interaction.options.data) {
            options[opt.name] = opt.value === undefined ? "" : String(opt.value);
          }
          const reduced: CommandInteraction = {
            commandName: interaction.commandName,
            options,
            userId: interaction.user.id,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            reply: (content: string) =>
              this.queue
                .enqueue(async () => {
                  await interaction.editReply({ content });
                }, 1)
                .catch((err) => {
                  this.log.warn({ err, command: interaction.commandName }, "failed to edit deferred reply");
                }),
          };
          for (const handler of this.commandHandlers) {
            try {
              await handler(reduced);
            } catch (err) {
              this.log.error({ err, command: reduced.commandName }, "command handler failed");
            }
          }
        })();
        return;
      }

      // Autocomplete: resolve choices synchronously against game data and
      // respond (must answer within Discord's 3s window; do NOT queue).
      if (interaction.isAutocomplete()) {
        void (async () => {
          const focused = interaction.options.getFocused(true);
          const reduced: AutocompleteInteraction = {
            commandName: interaction.commandName,
            focusedOption: focused.name,
            value: String(focused.value ?? ""),
            userId: interaction.user.id,
            guildId: interaction.guildId,
          };
          const choices: { name: string; value: string }[] = [];
          for (const handler of this.autocompleteHandlers) {
            try {
              choices.push(...(await handler(reduced)));
            } catch (err) {
              this.log.warn({ err, command: reduced.commandName }, "autocomplete handler failed");
            }
          }
          await interaction.respond(choices.slice(0, 25)).catch(() => {});
        })();
      }
    });
  }

  /** Register a handler for button/select interactions (plain data only). */
  onComponent(handler: ComponentHandler): void {
    this.componentHandlers.push(handler);
  }

  /** Register a handler for slash-command interactions (plain data + reply cb). */
  onCommand(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  /** Register a handler for autocomplete interactions (plain data → choices). */
  onAutocomplete(handler: AutocompleteHandler): void {
    this.autocompleteHandlers.push(handler);
  }

  /**
   * Idempotently register this bot's slash commands for one guild (§9). A bulk
   * PUT overwrites the guild's command set for this application, so re-running
   * on every boot converges without duplicates — that IS the idempotency.
   * Guild-scoped commands appear instantly (no ~1h global propagation).
   */
  async registerApplicationCommands(guildId: string, defs: CommandRegistration[]): Promise<void> {
    const appId = this.client.application?.id ?? this.client.user?.id;
    if (!appId) {
      this.log.warn({ guildId }, "cannot register commands before login");
      return;
    }
    const body = toApplicationCommandJson(defs);
    const rest = new REST().setToken(this.opts.token);
    await this.queue.enqueue(async () => {
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
      this.log.info({ guildId, commands: defs.map((def) => def.name) }, "slash commands registered");
    }, 2);
  }

  async login(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.client.once("ready", () => {
        this.log.info({ user: this.client.user?.tag }, "gateway ready");
        resolve();
      });
      void this.client.login(this.opts.token);
    });
  }

  /** Apply the per-guild nickname idempotently (§4, §9 boot registration). */
  async applyPersonas(): Promise<void> {
    for (const guildId of this.opts.personas.guildIds) {
      const persona = this.opts.personas.resolve(guildId);
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) {
        this.log.warn({ guildId }, "not a member of guild; skipping persona");
        continue;
      }
      await this.queue.enqueue(async () => {
        const me = await guild.members.fetchMe();
        if (me.nickname !== persona.nickname) {
          await me.setNickname(persona.nickname).catch((err) => {
            this.log.warn({ err, guildId }, "failed to set nickname");
          });
        }
      }, 2);
    }
  }

  async fetchGuild(guildId: string): Promise<Guild | null> {
    return this.client.guilds.cache.get(guildId) ?? null;
  }

  /** Send a message through the queue; caller resolves the persona for wording. */
  send(channel: SendableChannels, content: string | MessagePayload | MessageCreateOptions): Promise<unknown> {
    return this.queue.enqueue(async () => channel.send(content), 1);
  }

  /** Resolve a guild text-based channel (text channel or thread) by id. */
  private async fetchTextBased(channelId: string): Promise<GuildTextBasedChannel | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      this.log.warn({ channelId }, "channel is missing or not guild-text-based");
      return null;
    }
    return channel;
  }

  /** Send plain-data message options (embeds/components JSON) to a channel or thread. */
  sendToChannel(channelId: string, content: string | MessageCreateOptions): Promise<string | null> {
    return this.queue.enqueue(async () => {
      const channel = await this.fetchTextBased(channelId);
      if (!channel) return null;
      const message = await channel.send(content);
      return message.id;
    }, 1);
  }

  /**
   * Keep one pinned message per (channel, purpose): edit the known message if
   * it still exists, otherwise send a fresh one and pin it. Returns the id the
   * caller should persist for the next upsert (§5.3 "a pinned embed").
   */
  upsertPinnedMessage(
    channelId: string,
    existingMessageId: string | null,
    content: MessageCreateOptions,
  ): Promise<string | null> {
    return this.queue.enqueue(async () => {
      const channel = await this.fetchTextBased(channelId);
      if (!channel) return null;
      if (existingMessageId) {
        const existing = await channel.messages.fetch(existingMessageId).catch(() => null);
        if (existing) {
          await existing.edit({ content: content.content ?? null, embeds: content.embeds ?? [], components: content.components ?? [] });
          return existing.id;
        }
      }
      const message = await channel.send(content);
      await message.pin().catch((err) => {
        this.log.warn({ err, channelId }, "failed to pin message (need Manage Messages)");
      });
      return message.id;
    }, 2);
  }

  /**
   * Open a per-player conversation thread off a location channel (§5.4).
   * Private thread with the player invited; falls back to a public thread when
   * private threads are unavailable (missing permission/tier). A literal
   * `{user}` in `name` is replaced with the player's display name.
   */
  createPrivateThread(channelId: string, name: string, userId: string): Promise<string | null> {
    return this.queue.enqueue(async () => {
      const channel = await this.fetchTextBased(channelId);
      if (!channel || channel.isThread() || channel.type !== ChannelType.GuildText) {
        this.log.warn({ channelId }, "cannot create a thread here");
        return null;
      }
      const parent = channel as TextChannel;
      if (name.includes("{user}")) {
        const user = await this.client.users.fetch(userId).catch(() => null);
        name = name.replace("{user}", user?.displayName ?? user?.username ?? "traveller");
      }
      let thread;
      try {
        thread = await parent.threads.create({
          name,
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
      } catch (err) {
        this.log.warn({ err, channelId }, "private thread failed; falling back to public");
        thread = await parent.threads.create({
          name,
          type: ChannelType.PublicThread,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
      }
      await thread.members.add(userId).catch((err) => {
        this.log.warn({ err, userId }, "failed to add player to thread");
      });
      return thread.id;
    }, 2);
  }

  /**
   * Provision a land plot's Discord surface: a text channel (the anchor for the
   * owner's building threads, later) and a voice channel (where NPCs gather),
   * both under the given "Land" category. Needs Manage Channels; returns null on
   * a missing guild or permission failure so the caller can fall back to a
   * DB-only plot. Both channels share the owner's display name for readability.
   */
  createPlotChannels(
    guildId: string,
    userId: string,
    parentId: string,
  ): Promise<{ textId: string; voiceId: string } | null> {
    return this.queue.enqueue(async () => {
      const guild = await this.fetchGuild(guildId);
      if (!guild) {
        this.log.warn({ guildId }, "cannot provision plot channels: guild not cached");
        return null;
      }
      const user = await this.client.users.fetch(userId).catch(() => null);
      const label = user?.displayName ?? user?.username ?? "settler";
      // Track the text channel so we can roll it back if the voice create fails —
      // otherwise a half-provisioned plot leaks an orphan the caller can't see.
      let text: Awaited<ReturnType<typeof guild.channels.create>> | null = null;
      try {
        text = await guild.channels.create({ name: `${label}'s Estate`, type: ChannelType.GuildText, parent: parentId });
        const voice = await guild.channels.create({ name: `${label}'s Estate`, type: ChannelType.GuildVoice, parent: parentId });
        return { textId: text.id, voiceId: voice.id };
      } catch (err) {
        this.log.warn({ err, guildId, userId }, "failed to create plot channels (need Manage Channels)");
        if (text) await text.delete().catch(() => {}); // roll back the orphaned text channel
        return null;
      }
    }, 2);
  }

  /**
   * Grant a member a role (§2.2 discovery: the permanent view-role grant when a
   * player first enters a district). Best-effort + dev-server-exercised like
   * createPlotChannels — needs Manage Roles and the role below the bot's highest
   * role; skips with a log otherwise rather than failing the arrival.
   */
  grantRole(guildId: string, userId: string, roleId: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const guild = await this.fetchGuild(guildId);
      if (!guild) return;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return;
      await member.roles.add(roleId).catch((err) => {
        this.log.warn({ err, guildId, userId, roleId }, "failed to grant role (need Manage Roles / role hierarchy)");
      });
    }, 1);
  }

  archiveThread(threadId: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const channel = await this.client.channels.fetch(threadId).catch(() => null);
      if (!channel || !channel.isThread()) return;
      await channel.setArchived(true).catch((err) => {
        this.log.warn({ err, threadId }, "failed to archive thread");
      });
    }, 1);
  }

  /**
   * Stand in a guild voice channel for presence only (§5.1): self-muted and
   * self-deafened, we never transmit or listen — the bot just appears in the
   * channel as a visible NPC. One connection per guild ("one place at a time"):
   * joining another channel in the same guild replaces the previous connection.
   * Non-blocking — the bot shows up via the voice-state update without waiting
   * for the UDP handshake, which keeps a slow/absent voice path from stalling boot.
   */
  async joinVoice(
    guildId: string,
    channelId: string,
    opts: { selfMute?: boolean; selfDeaf?: boolean } = {},
  ): Promise<boolean> {
    const guild = await this.fetchGuild(guildId);
    if (!guild) {
      this.log.warn({ guildId, channelId }, "cannot join voice: guild not cached");
      return false;
    }
    this.leaveVoice(guildId); // one place at a time
    try {
      const connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfMute: opts.selfMute ?? true,
        selfDeaf: opts.selfDeaf ?? true,
      });
      connection.on("error", (err) => this.log.warn({ err, guildId }, "voice connection error"));
      this.voiceConnections.set(guildId, connection);
      this.log.info({ guildId, channelId }, "joined voice channel (self-muted)");
      return true;
    } catch (err) {
      // Best-effort presence — a voice failure must never crash boot.
      this.log.warn({ err, guildId, channelId }, "failed to join voice channel");
      return false;
    }
  }

  /** Leave the voice channel in a guild, if connected. */
  leaveVoice(guildId: string): void {
    const connection = this.voiceConnections.get(guildId);
    if (!connection) return;
    connection.destroy();
    this.voiceConnections.delete(guildId);
    this.log.info({ guildId }, "left voice channel");
  }

  async destroy(): Promise<void> {
    for (const connection of this.voiceConnections.values()) connection.destroy();
    this.voiceConnections.clear();
    await this.client.destroy();
  }
}
