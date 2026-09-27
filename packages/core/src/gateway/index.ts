/**
 * Discord gateway wrapper (framework spec §3, §9). This directory is the ONLY
 * place that touches discord.js's client; nothing outside @empire/core imports
 * discord.js directly.
 *
 * Responsibilities are split three ways:
 *   types.ts        the plain-data shapes capabilities actually see (invariant #4)
 *   interactions.ts reducing + routing inbound interactions
 *   this file       the client itself and every OUTBOUND call — personas,
 *                   messages, threads, channels, roles, voice
 *
 * All outbound work goes through one small FIFO queue for rate-limit hygiene
 * (§9), and each call contains its own Discord failures: most callers are bus
 * handlers, where a rejection is only ever logged and skipped.
 */
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type GuildTextBasedChannel,
  type MessageCreateOptions,
  type Guild,
  type TextChannel,
} from "discord.js";
import { joinVoiceChannel, type VoiceConnection } from "@discordjs/voice";
import type { Logger } from "../logger.js";
import { rootLogger } from "../logger.js";
import { CallQueue } from "./call-queue.js";
import { InteractionRouter } from "./interactions.js";
import { plotOverwrites } from "./plot-privacy.js";
import type {
  AutocompleteHandler,
  CommandHandler,
  CommandRegistration,
  ComponentHandler,
  GatewayOptions,
  MemberJoinHandler,
  ModalRequest,
  ModalSubmitHandler,
} from "./types.js";
import { toApplicationCommandJson } from "./types.js";

export * from "./types.js";
export { toApplicationCommandJson } from "./types.js";

export class Gateway {
  readonly client: Client;
  readonly queue = new CallQueue();
  private readonly log: Logger;
  private readonly router: InteractionRouter;
  /** guildId → the bot's single voice connection there (one place at a time, §5.1). */
  private readonly voiceConnections = new Map<string, VoiceConnection>();

  constructor(private readonly opts: GatewayOptions) {
    this.log = (opts.logger ?? rootLogger).child({ component: "gateway", bot: opts.botId });
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers, // gatekeeper: guildMemberAdd (PRIVILEGED — enable in the dev portal)
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.router = new InteractionRouter(this.log, this.queue);
    this.router.attach(this.client);
  }

  /** Register a handler for button/select interactions (plain data only). */
  onComponent(handler: ComponentHandler): void {
    this.router.onComponent(handler);
  }

  /** Register a handler for slash-command interactions (plain data + reply cb). */
  onCommand(handler: CommandHandler): void {
    this.router.onCommand(handler);
  }

  /** Register a handler for autocomplete interactions (plain data → choices). */
  onAutocomplete(handler: AutocompleteHandler): void {
    this.router.onAutocomplete(handler);
  }

  /** Register a button→modal opener, checked before the auto-deferUpdate. */
  onModalRequest(request: ModalRequest): void {
    this.router.onModalRequest(request);
  }

  /** Register a handler for submitted modals (plain data + reply cb). */
  onModalSubmit(handler: ModalSubmitHandler): void {
    this.router.onModalSubmit(handler);
  }

  /** Register a handler for members joining a guild (§9 gatekeeper). */
  onMemberJoin(handler: MemberJoinHandler): void {
    this.router.onMemberJoin(handler);
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
    });
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
      });
    }
  }

  async fetchGuild(guildId: string): Promise<Guild | null> {
    return this.client.guilds.cache.get(guildId) ?? null;
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

  /**
   * Send plain-data message options (embeds/components JSON) to a channel or
   * thread; returns the new message id, or null if it couldn't be delivered.
   *
   * Delivery failures (a revoked SEND_MESSAGES, a since-deleted channel, a 5xx)
   * resolve to null rather than rejecting. Most callers are bus handlers, and a
   * rejection there would be logged-and-skipped by the bus at best — better to
   * make "couldn't post" an ordinary outcome, matching the missing-channel case.
   */
  sendToChannel(channelId: string, content: string | MessageCreateOptions): Promise<string | null> {
    return this.queue.enqueue(async () => {
      const channel = await this.fetchTextBased(channelId);
      if (!channel) return null;
      try {
        const message = await channel.send(content);
        return message.id;
      } catch (err) {
        this.log.warn({ err, channelId }, "failed to send message (need Send Messages?)");
        return null;
      }
    });
  }

  /**
   * Keep one pinned message per (channel, purpose): edit the known message if
   * it still exists, otherwise send a fresh one and pin it. Returns the id the
   * caller should persist for the next upsert (§5.3 "a pinned embed").
   *
   * A FAILED EDIT keeps the existing id rather than posting a replacement: the
   * surface goes stale until the next render instead of leaving a second pinned
   * embed behind every time Discord hiccups. A deleted message is a different
   * case — the fetch returns null and we legitimately post a fresh one.
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
          try {
            await existing.edit({ content: content.content ?? null, embeds: content.embeds ?? [], components: content.components ?? [] });
          } catch (err) {
            this.log.warn({ err, channelId, messageId: existing.id }, "failed to edit pinned message; leaving it stale");
          }
          return existing.id;
        }
      }
      let message;
      try {
        message = await channel.send(content);
      } catch (err) {
        this.log.warn({ err, channelId }, "failed to post pinned message (need Send Messages?)");
        return null;
      }
      await message.pin().catch((err) => {
        this.log.warn({ err, channelId }, "failed to pin message (need Manage Messages)");
      });
      return message.id;
    });
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
        try {
          thread = await parent.threads.create({
            name,
            type: ChannelType.PublicThread,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          });
        } catch (fallbackErr) {
          // No thread at all — the caller skips the render rather than crashing.
          this.log.warn({ err: fallbackErr, channelId }, "public thread fallback failed too (need Create Threads?)");
          return null;
        }
      }
      await thread.members.add(userId).catch((err) => {
        this.log.warn({ err, userId }, "failed to add player to thread");
      });
      return thread.id;
    });
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
      // §2.4: private from the first instant — the overwrites ride on the create
      // call itself rather than being applied afterwards.
      const botRoleIds = await this.botRoleIds(guild);
      const privacy = (kind: "text" | "voice") => plotOverwrites({ everyoneRoleId: guild.roles.everyone.id, ownerId: userId, botRoleIds, kind });
      // Track the text channel so we can roll it back if the voice create fails —
      // otherwise a half-provisioned plot leaks an orphan the caller can't see.
      let text: Awaited<ReturnType<typeof guild.channels.create>> | null = null;
      try {
        text = await guild.channels.create({
          name: `${label}'s Estate`,
          type: ChannelType.GuildText,
          parent: parentId,
          permissionOverwrites: privacy("text"),
        });
        const voice = await guild.channels.create({
          name: `${label}'s Estate`,
          type: ChannelType.GuildVoice,
          parent: parentId,
          permissionOverwrites: privacy("voice"),
        });
        return { textId: text.id, voiceId: voice.id };
      } catch (err) {
        this.log.warn({ err, guildId, userId }, "failed to create plot channels (need Manage Channels)");
        if (text) await text.delete().catch(() => {}); // roll back the orphaned text channel
        return null;
      }
    });
  }

  /**
   * Every bot's integration role in the guild — how bots see private places.
   * Filtered on `tags.botId`, NOT on `managed`: Discord also marks the Server
   * Booster role as managed, and boosting must not buy a view into other
   * players' estates.
   */
  private async botRoleIds(guild: Guild): Promise<string[]> {
    const roles = await guild.roles.fetch().catch(() => null);
    return roles ? [...roles.filter((r) => Boolean(r.tags?.botId)).keys()] : [];
  }

  /**
   * Re-apply a plot's privacy (§2.4) to its existing channels — the boot-time
   * heal for plots created before lands were private, or hand-edited since.
   * `set` replaces the whole overwrite list, so re-running converges. An owner
   * who has left the guild can't hold a member overwrite; the plot is still
   * hidden from everyone else. Best-effort: returns false (and logs) on a missing
   * guild/channel or a permission failure (needs Manage Channels + Manage Roles).
   */
  applyPlotPrivacy(guildId: string, ownerId: string, textId: string | null, voiceId: string | null): Promise<boolean> {
    return this.queue.enqueue(async () => {
      const guild = await this.fetchGuild(guildId);
      if (!guild) return false;
      const member = await guild.members.fetch(ownerId).catch(() => null);
      const botRoleIds = await this.botRoleIds(guild);
      let ok = true;
      for (const [channelId, kind] of [[textId, "text"], [voiceId, "voice"]] as const) {
        if (!channelId) continue;
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !("permissionOverwrites" in channel)) {
          ok = false;
          continue;
        }
        const overwrites = plotOverwrites({ everyoneRoleId: guild.roles.everyone.id, ownerId: member ? ownerId : null, botRoleIds, kind });
        await channel.permissionOverwrites.set(overwrites).catch((err: unknown) => {
          ok = false;
          this.log.warn({ err, guildId, channelId }, "failed to apply plot privacy (need Manage Channels + Manage Roles)");
        });
      }
      return ok;
    });
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
    });
  }

  archiveThread(threadId: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const channel = await this.client.channels.fetch(threadId).catch(() => null);
      if (!channel || !channel.isThread()) return;
      await channel.setArchived(true).catch((err) => {
        this.log.warn({ err, threadId }, "failed to archive thread");
      });
    });
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
