/**
 * Reducing Discord interactions to plain data, and fanning them out (framework
 * spec §5.6, invariant #4).
 *
 * This is the one place a raw discord.js Interaction is touched. Every branch
 * does the same three things — acknowledge fast enough for Discord's window,
 * reduce the interaction to a plain object, then hand it to registered handlers
 * — but each acknowledges DIFFERENTLY, and those differences are the whole
 * subtlety of the file:
 *
 *   button/select   deferUpdate immediately (no spinner); replies are follow-ups
 *   button→modal    must NOT be acknowledged first, so it is intercepted before
 *   slash command   deferReply ephemerally; the answer may arrive via the bus
 *   autocomplete    must answer within ~3s, so it does NOT go through the queue
 *   modal submit    not auto-acked at all; defers lazily on first reply
 *
 * Handler failures are caught per handler: one capability throwing must not
 * rob the others of an interaction they were also registered for.
 */
import {
  ComponentType,
  type AutocompleteInteraction as DjsAutocomplete,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type MessageCreateOptions,
  type ModalSubmitInteraction as DjsModalSubmit,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Logger } from "../logger.js";
import type { CallQueue } from "./call-queue.js";
import type {
  AutocompleteHandler,
  AutocompleteInteraction,
  CommandHandler,
  CommandInteraction,
  CommandReply,
  ComponentHandler,
  ComponentInteraction,
  MemberJoin,
  MemberJoinHandler,
  ModalRequest,
  ModalSubmitHandler,
  ModalSubmitInteraction,
} from "./types.js";

/** Discord's cap on autocomplete choices in one response. */
const MAX_CHOICES = 25;

/**
 * Owns the handler registries and the interactionCreate/guildMemberAdd routing.
 * The Gateway holds one and delegates its `on*` methods to it.
 */
export class InteractionRouter {
  private readonly componentHandlers: ComponentHandler[] = [];
  private readonly commandHandlers: CommandHandler[] = [];
  private readonly autocompleteHandlers: AutocompleteHandler[] = [];
  private readonly modalRequests: ModalRequest[] = [];
  private readonly modalSubmitHandlers: ModalSubmitHandler[] = [];
  private readonly memberJoinHandlers: MemberJoinHandler[] = [];

  constructor(
    private readonly log: Logger,
    private readonly queue: CallQueue,
  ) {}

  onComponent(handler: ComponentHandler): void {
    this.componentHandlers.push(handler);
  }
  onCommand(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }
  onAutocomplete(handler: AutocompleteHandler): void {
    this.autocompleteHandlers.push(handler);
  }
  onModalRequest(request: ModalRequest): void {
    this.modalRequests.push(request);
  }
  onModalSubmit(handler: ModalSubmitHandler): void {
    this.modalSubmitHandlers.push(handler);
  }
  onMemberJoin(handler: MemberJoinHandler): void {
    this.memberJoinHandlers.push(handler);
  }

  /** Subscribe to the client's interaction + member-join events. */
  attach(client: Client): void {
    client.on("interactionCreate", (interaction) => {
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        void this.handleComponent(interaction);
      } else if (interaction.isChatInputCommand()) {
        void this.handleCommand(interaction);
      } else if (interaction.isAutocomplete()) {
        void this.handleAutocomplete(interaction);
      } else if (interaction.isModalSubmit()) {
        void this.handleModalSubmit(interaction);
      }
    });

    // Members joining a guild (§9 gatekeeper). Requires the privileged
    // GuildMembers intent (enabled on the client + in the dev portal).
    client.on("guildMemberAdd", (member) => {
      void this.fanOut(this.memberJoinHandlers, { guildId: member.guild.id, userId: member.id }, "member-join");
    });
  }

  /** Run every handler, isolating failures so one bad handler doesn't stop the rest. */
  private async fanOut<T>(handlers: ((arg: T) => Promise<void> | void)[], arg: T, kind: string): Promise<void> {
    for (const handler of handlers) {
      try {
        await handler(arg);
      } catch (err) {
        this.log.error({ err, kind }, `${kind} handler failed`);
      }
    }
  }

  /**
   * Button / select click. Acked with deferUpdate so Discord never shows a
   * spinner — the visible response arrives later via bus-driven renders.
   */
  private async handleComponent(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    // A button may open a modal, which Discord only permits on a NOT-yet-acked
    // interaction — so this has to run before the deferUpdate below.
    if (interaction.isButton()) {
      const req = this.modalRequests.find((r) => r.matches(interaction.customId));
      if (req) {
        await interaction
          .showModal(req.build(interaction.customId, interaction.user.id))
          .catch((err) => this.log.warn({ err, customId: interaction.customId }, "failed to show modal"));
        return;
      }
    }
    await interaction.deferUpdate().catch(() => {});
    await this.fanOut(this.componentHandlers, this.reduceComponent(interaction), "component");
  }

  private reduceComponent(interaction: ButtonInteraction | StringSelectMenuInteraction): ComponentInteraction {
    return {
      customId: interaction.customId,
      values: interaction.isStringSelectMenu() ? [...interaction.values] : [],
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      reply: (content: string) =>
        this.queue
          .enqueue(async () => {
            await interaction.followUp({ content, ephemeral: true });
          })
          .catch((err) => {
            this.log.warn({ err, customId: interaction.customId }, "failed to send ephemeral follow-up");
          }),
      update: (content: MessageCreateOptions) =>
        this.queue
          .enqueue(async () => {
            await interaction.editReply(content as Parameters<typeof interaction.editReply>[0]);
          })
          .catch((err) => {
            this.log.warn({ err, customId: interaction.customId }, "failed to edit component message");
          }),
    };
  }

  /**
   * Slash command. Deferred ephemerally at once because the result may only
   * arrive after a bus round-trip; `reply` then edits that deferred response,
   * so the Interaction itself never leaves the gateway.
   */
  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
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
      reply: (response: string | CommandReply) =>
        this.queue
          .enqueue(async () => {
            const payload = typeof response === "string" ? { content: response } : response;
            await interaction.editReply(payload as never);
          })
          .catch((err) => {
            this.log.warn({ err, command: interaction.commandName }, "failed to edit deferred reply");
          }),
    };
    await this.fanOut(this.commandHandlers, reduced, "command");
  }

  /**
   * Autocomplete. Answered directly against game data and deliberately NOT put
   * through the call queue — Discord drops the response after ~3 seconds, and
   * queueing behind other outbound work would blow that budget.
   */
  private async handleAutocomplete(interaction: DjsAutocomplete): Promise<void> {
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
    await interaction.respond(choices.slice(0, MAX_CHOICES)).catch(() => {});
  }

  /** Modal submit. Not auto-acked (there's no spinner), so `reply` defers lazily. */
  private async handleModalSubmit(interaction: DjsModalSubmit): Promise<void> {
    const fields: Record<string, string> = {};
    interaction.fields.fields.forEach((comp) => {
      if (comp.type === ComponentType.TextInput) fields[comp.customId] = comp.value;
    });
    const reduced: ModalSubmitInteraction = {
      customId: interaction.customId,
      fields,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      reply: (content: string) =>
        this.queue
          .enqueue(async () => {
            if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
            await interaction.editReply({ content });
          })
          .catch((err) => {
            this.log.warn({ err, customId: interaction.customId }, "failed to reply to modal submit");
          }),
    };
    await this.fanOut(this.modalSubmitHandlers, reduced, "modal submit");
  }
}

export type { MemberJoin };
