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
  ThreadAutoArchiveDuration,
  type GuildTextBasedChannel,
  type SendableChannels,
  type MessageCreateOptions,
  type MessagePayload,
  type Guild,
  type TextChannel,
} from "discord.js";
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
}

export type ComponentHandler = (interaction: ComponentInteraction) => Promise<void> | void;

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
    // Route button/select clicks to registered capability handlers as plain
    // data. Ack immediately (deferUpdate) so Discord never shows a spinner;
    // the visible response arrives via bus-driven renders.
    this.client.on("interactionCreate", (interaction) => {
      if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
      void (async () => {
        await interaction.deferUpdate().catch(() => {});
        const reduced: ComponentInteraction = {
          customId: interaction.customId,
          values: interaction.isStringSelectMenu() ? [...interaction.values] : [],
          userId: interaction.user.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
        };
        for (const handler of this.componentHandlers) {
          try {
            await handler(reduced);
          } catch (err) {
            this.log.error({ err, customId: reduced.customId }, "component handler failed");
          }
        }
      })();
    });
  }

  /** Register a handler for button/select interactions (plain data only). */
  onComponent(handler: ComponentHandler): void {
    this.componentHandlers.push(handler);
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

  archiveThread(threadId: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const channel = await this.client.channels.fetch(threadId).catch(() => null);
      if (!channel || !channel.isThread()) return;
      await channel.setArchived(true).catch((err) => {
        this.log.warn({ err, threadId }, "failed to archive thread");
      });
    }, 1);
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }
}
