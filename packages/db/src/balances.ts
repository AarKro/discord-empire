/**
 * Balance reads (framework spec §8). Balances are a derived cache over the
 * ledger; this is the single place capabilities read a wallet from, so the
 * `SELECT amount FROM balances …` shape isn't re-inlined per call site.
 */
import type { Sql } from "./client.js";

/**
 * The owner's balance in `currency`, or 0 when no row exists yet (a wallet is
 * only materialised on first credit). `ownerKind` is 'player' | 'npc' | … .
 */
export async function readBalance(
  sql: Sql,
  ownerKind: string,
  ownerId: string,
  currency = "gold",
): Promise<number> {
  const [row] = await sql<{ amount: number }[]>`
    SELECT amount FROM balances
    WHERE owner_kind = ${ownerKind} AND owner_id = ${ownerId} AND currency = ${currency}
  `;
  return row?.amount ?? 0;
}
