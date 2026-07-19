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
  Client,
  GatewayIntentBits,
  type SendableChannels,
  type MessageCreateOptions,
  type MessagePayload,
  type Guild,
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

  async destroy(): Promise<void> {
    await this.client.destroy();
  }
}
