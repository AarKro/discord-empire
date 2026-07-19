/**
 * Player onboarding (framework spec §2.1 "auto-register on first interaction").
 *
 * A player exists the first time they click something. The starting-gold grant
 * is written as a ledger row (reason 'starting_grant', counterparty `world`)
 * in the SAME transaction as the players/balances rows, so the "balances are
 * derived from the ledger and reconcile" invariant (§8) holds from row one.
 */
import type { Sql } from "./client.js";
import { jsonParam } from "./client.js";

export interface EnsurePlayerResult {
  /** True when this call created the player (and granted starting gold). */
  created: boolean;
}

export async function ensurePlayer(
  sql: Sql,
  playerId: string,
  homeGuildId: string,
  startingGold: number,
): Promise<EnsurePlayerResult> {
  return sql.begin(async (tx) => {
    // ON CONFLICT DO NOTHING + RETURNING: rows come back only on first insert,
    // which makes the grant exactly-once even under concurrent double clicks.
    const inserted = await tx`
      INSERT INTO players (discord_user_id, home_guild_id, position_guild_id)
      VALUES (${playerId}, ${homeGuildId}, ${homeGuildId})
      ON CONFLICT (discord_user_id) DO NOTHING
      RETURNING discord_user_id
    `;
    if (inserted.length === 0) return { created: false };

    if (startingGold > 0) {
      await tx`
        INSERT INTO balances (owner_kind, owner_id, currency, amount)
        VALUES ('player', ${playerId}, 'gold', ${startingGold})
        ON CONFLICT (owner_kind, owner_id, currency)
        DO UPDATE SET amount = balances.amount + ${startingGold}
      `;
      await tx`
        INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason)
        VALUES ('player', ${playerId}, 'world', 'world', 'gold', ${startingGold}, ${jsonParam(sql, {})}, 'starting_grant')
      `;
    }
    return { created: true };
  });
}
