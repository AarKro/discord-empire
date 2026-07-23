/**
 * topology (framework spec §2.3, §5.14) — position, travel & discovery.
 *
 * Iteration-1 scope: the `requires_presence` check every interactive capability
 * calls before acting, plus the travel-as-prefix helper and co-presence
 * contact/discovery recording. Full travel timers ride on the workflow engine;
 * this module owns the DB-level position truth and the presence gate.
 */
import type { Capability, CapabilityContext } from "../capability.js";
import type { Sql } from "@empire/db";

export interface PresenceCheck {
  present: boolean;
  /** In-fiction refusal when not present (§2.3). */
  reason?: string;
}

/**
 * Hard presence gate (§2.3): a player interacts only where the database says
 * they stand. Returns an in-fiction refusal otherwise.
 */
export async function requiresPresence(
  sql: Sql,
  playerId: string,
  locationId: string,
): Promise<PresenceCheck> {
  const [location] = await sql<{ guild_id: string; district_id: string | null; requires_presence: boolean }[]>`
    SELECT guild_id, district_id, requires_presence FROM locations WHERE id = ${locationId}
  `;
  if (!location) return { present: false, reason: "there is no such place" };
  if (!location.requires_presence) return { present: true };

  const [player] = await sql<{ position_guild_id: string | null; position_district_id: string | null }[]>`
    SELECT position_guild_id, position_district_id FROM players WHERE discord_user_id = ${playerId}
  `;
  if (!player) return { present: false, reason: "you are nowhere yet" };

  const here =
    player.position_guild_id === location.guild_id &&
    (location.district_id === null || player.position_district_id === location.district_id);
  if (!here) return { present: false, reason: "that place is a walk from where you stand" };
  return { present: true };
}

/** Record permanent district discovery + co-presence contacts (§2.2, §2.3). */
async function arrive(
  sql: Sql,
  playerId: string,
  guildId: string,
  districtId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE players SET position_guild_id = ${guildId}, position_district_id = ${districtId}
      WHERE discord_user_id = ${playerId}
    `;
    await tx`
      INSERT INTO discoveries (player_id, district_id) VALUES (${playerId}, ${districtId})
      ON CONFLICT DO NOTHING
    `;
    // Co-presence: everyone else standing in this district becomes a contact.
    const others = await tx<{ discord_user_id: string }[]>`
      SELECT discord_user_id FROM players
      WHERE position_guild_id = ${guildId} AND position_district_id = ${districtId}
        AND discord_user_id <> ${playerId}
    `;
    for (const other of others) {
      const [first, second] = [playerId, other.discord_user_id].sort();
      await tx`INSERT INTO contacts (player_a, player_b) VALUES (${first!}, ${second!}) ON CONFLICT DO NOTHING`;
    }
  });
}

export function topologyCapability(): Capability {
  /** Resolve the /move ephemeral reply (a generic command.reply the commands cap settles). */
  async function reply(ctx: CapabilityContext, evt: { guildId?: string | null; correlationId?: string | null } | null, player: string, message: string): Promise<void> {
    await ctx.bus.publish({
      type: "command.reply",
      guildId: evt?.guildId ?? null,
      actor: { kind: "player", id: player },
      subject: { kind: "npc", id: ctx.bot },
      payload: { message },
      correlationId: evt?.correlationId ?? null,
    });
  }

  return {
    name: "topology",
    consumes: [],
    actions: {
      /**
       * Set off for an adjacent district (§2.3 walk): validate the target is a
       * neighbour of where the player stands (districts ring), clear the district
       * ("walking" — a null-district re-entrancy guard), confirm via command.reply.
       * A bad hop / already-walking replies then throws → workflow on_error.
       */
      "district.depart": async (args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        const target = String(args.district ?? "");
        const [pos] = await ctx.sql<{ position_district_id: string | null }[]>`
          SELECT position_district_id FROM players WHERE discord_user_id = ${player}
        `;
        const current = pos?.position_district_id ?? null;
        if (!current) {
          await reply(ctx, evt, player, "You're already on the move, friend — one road at a time.");
          throw new Error("already walking");
        }
        const [here] = await ctx.sql<{ neighbors: string[] }[]>`SELECT neighbors FROM districts WHERE id = ${current}`;
        if (!target || !(here?.neighbors ?? []).includes(target)) {
          await reply(ctx, evt, player, "There's no path to that quarter from where you stand.");
          throw new Error("invalid district");
        }
        await ctx.sql`UPDATE players SET position_district_id = ${null} WHERE discord_user_id = ${player}`;
        const [dest] = await ctx.sql<{ name: string }[]>`SELECT name FROM districts WHERE id = ${target}`;
        await reply(ctx, evt, player, `You set off for ${dest?.name ?? "the next quarter"} — a short walk.`);
        ctx.logger.info({ player, from: current, to: target }, "district walk started");
      },

      /**
       * Arrive in the target district (fired by the walk timer): record position +
       * permanent discovery + co-presence contacts, then grant the district's Discord
       * view-role so its channels appear (§2.2 RTS reveal), and announce discovery.
       */
      "district.arrive": async (args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        const district = String(args.district ?? "");
        if (!district) return;
        const [pos] = await ctx.sql<{ position_guild_id: string | null }[]>`
          SELECT position_guild_id FROM players WHERE discord_user_id = ${player}
        `;
        const guildId = pos?.position_guild_id;
        if (!guildId) return; // a district walk keeps the continent set; nothing to arrive into otherwise
        await arrive(ctx.sql, player, guildId, district);
        const [d] = await ctx.sql<{ view_role_id: string | null; name: string }[]>`
          SELECT view_role_id, name FROM districts WHERE id = ${district}
        `;
        if (d?.view_role_id) await ctx.gateway.grantRole(guildId, player, d.view_role_id);
        await ctx.bus.publish({
          type: "district.discovered",
          guildId,
          actor: { kind: "player", id: player },
          subject: { kind: "npc", id: ctx.bot },
          payload: { district, name: d?.name ?? district },
        });
        ctx.logger.info({ player, district }, "district arrived + discovered");
      },
    },
  };
}
