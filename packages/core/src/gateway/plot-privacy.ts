/**
 * Land privacy (framework spec §2.4): "permission overwrites for owner + bots
 * only; everything shared happens in public district channels."
 *
 * Pure — the overwrite list for one plot channel as plain data, so the rule is
 * unit-testable without a Discord client. The gateway applies it at creation
 * (so a plot is never public, even for a moment) and again on the builder's boot
 * (which heals plots created before this existed, and any hand edits).
 *
 * Bots reach every plot through their integration roles — the role Discord gives
 * each bot (`tags.botId`) — exactly as world-init's district gating does. Every bot that
 * writes into land (the builder's builds, the warden's battle logs, the
 * architect's research notices, the exchange's auctions and caravan stall, the
 * merchant's visits) keeps working with no list of bot ids to maintain.
 */
import { OverwriteType, PermissionFlagsBits } from "discord.js";

export type PlotChannelKind = "text" | "voice";

export interface PlotOverwrite {
  id: string;
  type: OverwriteType;
  allow: bigint[];
  deny: bigint[];
}

export interface PlotPrivacyInput {
  /** The guild's @everyone role — its id is the guild id. */
  everyoneRoleId: string;
  /** The plot's owner, or null when they are no longer a guild member. */
  ownerId: string | null;
  /** Every bot's integration role in the guild (never the managed Booster role). */
  botRoleIds: string[];
  kind: PlotChannelKind;
}

const P = PermissionFlagsBits;

/** What the owner may do: read and write their own estate (and its building threads). */
const OWNER_TEXT = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.SendMessagesInThreads];

/** What a bot needs to run the estate: post, open and archive private threads. */
const BOT_TEXT = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.SendMessagesInThreads, P.CreatePrivateThreads, P.ManageThreads];

export function plotOverwrites({ everyoneRoleId, ownerId, botRoleIds, kind }: PlotPrivacyInput): PlotOverwrite[] {
  const overwrites: PlotOverwrite[] = [
    { id: everyoneRoleId, type: OverwriteType.Role, allow: [], deny: [P.ViewChannel] },
  ];
  if (ownerId) {
    overwrites.push(
      kind === "text"
        ? { id: ownerId, type: OverwriteType.Member, allow: OWNER_TEXT, deny: [] }
        : // Voice only visualises who is visiting (§5.1): the owner sees the NPCs
          // gather, but players never join voice.
          { id: ownerId, type: OverwriteType.Member, allow: [P.ViewChannel], deny: [P.Connect] },
    );
  }
  for (const roleId of botRoleIds) {
    overwrites.push({
      id: roleId,
      type: OverwriteType.Role,
      allow: kind === "text" ? BOT_TEXT : [P.ViewChannel, P.Connect],
      deny: [],
    });
  }
  return overwrites;
}
