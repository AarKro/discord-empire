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

/**
 * Default starting-gold grant on first interaction (§2.1), overridable via
 * $STARTING_GOLD. Must clear the shipped haggle tree's `player.gold >= 120`
 * guard so a brand-new player can immediately trade.
 */
export const DEFAULT_STARTING_GOLD = Number(process.env.STARTING_GOLD ?? 150);

export async function ensurePlayer(
  sql: Sql,
  playerId: string,
  homeGuildId: string,
  startingGold: number = DEFAULT_STARTING_GOLD,
): Promise<EnsurePlayerResult> {
  return sql.begin(async (tx) => {
    // ON CONFLICT DO NOTHING + RETURNING: rows come back only on first insert,
    // which makes the grant exactly-once even under concurrent double clicks.
    // A fresh player stands in their home continent's bazaar district (§2.3) — the
    // public starting square — so they can immediately shop. Null-safe: before
    // districts are seeded this resolves to NULL (continent-only, as before).
    const inserted = await tx`
      INSERT INTO players (discord_user_id, home_guild_id, position_guild_id, position_district_id)
      VALUES (
        ${playerId}, ${homeGuildId}, ${homeGuildId},
        (SELECT district_id FROM locations WHERE guild_id = ${homeGuildId} AND kind = 'bazaar' LIMIT 1)
      )
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

/** A reward handed to a player by a workflow (§7): any of gold / item / reputation. */
export interface GrantSpec {
  player: string;
  /** The NPC crediting the reward — reputation is scored against them. */
  npc: string;
  gold?: number;
  item?: string;
  qty?: number;
  reputation?: number;
  /** Ledger reason for the gold/item grant (default 'reward'). */
  reason?: string;
}

/**
 * Grant a player a reward atomically. Gold/items are a `world → player` ledger
 * transaction (one row records both), so balances stay reconcilable (invariant
 * #2), mirroring ensurePlayer's starting grant. Reputation is a score bump on the
 * `reputation` table (not economy, so not ledgered). A no-op if nothing is given.
 */
export async function grantReward(sql: Sql, spec: GrantSpec): Promise<void> {
  const gold = spec.gold ?? 0;
  const qty = spec.item ? (spec.qty ?? 1) : 0;
  const rep = spec.reputation ?? 0;
  if (gold <= 0 && qty <= 0 && rep === 0) return;

  await sql.begin(async (tx) => {
    if (gold > 0) {
      await tx`
        INSERT INTO balances (owner_kind, owner_id, currency, amount)
        VALUES ('player', ${spec.player}, 'gold', ${gold})
        ON CONFLICT (owner_kind, owner_id, currency) DO UPDATE SET amount = balances.amount + ${gold}
      `;
    }
    if (spec.item && qty > 0) {
      await tx`
        INSERT INTO inventories (owner_kind, owner_id, item_id, qty)
        VALUES ('player', ${spec.player}, ${spec.item}, ${qty})
        ON CONFLICT (owner_kind, owner_id, item_id) DO UPDATE SET qty = inventories.qty + ${qty}
      `;
    }
    if (gold > 0 || qty > 0) {
      const itemDeltas = spec.item && qty > 0 ? { [spec.item]: qty } : {};
      await tx`
        INSERT INTO ledger (actor_kind, actor_id, counterparty_kind, counterparty_id, currency, currency_delta, item_deltas, reason)
        VALUES ('player', ${spec.player}, 'world', 'world', 'gold', ${gold}, ${jsonParam(sql, itemDeltas)}, ${spec.reason ?? "reward"})
      `;
    }
    if (rep !== 0) {
      await tx`
        INSERT INTO reputation (player_id, npc_id, score)
        VALUES (${spec.player}, ${spec.npc}, ${rep})
        ON CONFLICT (player_id, npc_id) DO UPDATE SET score = reputation.score + ${rep}
      `;
    }
  });
}
