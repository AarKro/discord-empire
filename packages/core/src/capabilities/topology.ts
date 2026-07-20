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
  return {
    name: "topology",
    consumes: ["travel.arrived", "district."],
    actions: {
      "travel.arrive": async (args, _evt, ctx: CapabilityContext) => {
        const playerId = String(args.player);
        const guildId = String(args.guild_id);
        const districtId = String(args.district);
        await arrive(ctx.sql, playerId, guildId, districtId);
        await ctx.bus.publish({
          type: "district.discovered",
          guildId,
          actor: { kind: "player", id: playerId },
          payload: { district: districtId },
        });
      },
    },
  };
}
