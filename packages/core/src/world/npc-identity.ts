/**
 * NPC commerce identity (framework spec §2.5 local trade goods).
 *
 * One bot process wears a different face on every continent — `merchant` is
 * Aldric in the Highlands, Mei Lin in the harbour, Hazel in the Thornwild (see
 * each manifest's `personas` map). Until now those faces shared one purse: stock
 * and reputation were keyed on the bare bot id, so buying bread in the Thornwild
 * decremented the same row as buying it in the Highlands.
 *
 * Two identities therefore have to be told apart, and the split is the whole
 * design:
 *
 *   COMMERCE identity — `npcAt(bot, guild)`. Owns `inventories` stock, stands as
 *     the ledger counterparty, and carries `reputation`. Forks per continent,
 *     because Aldric and Mei Lin genuinely are different traders and standing
 *     earned with one should not follow you to the other.
 *
 *   BOOKKEEPING identity — plain `ctx.bot`. The `npcs` row and its `state` jsonb
 *     (stall pins, board pins, wander position), plus bus addressing / notForMe.
 *     Stays global: there is one process, one gateway, one set of pinned messages
 *     per guild already keyed inside that state.
 *
 * Keeping bookkeeping on `ctx.bot` is what stops this from rippling through
 * travel, render, offer-board and riddle, none of which care where stock lives.
 */

/**
 * The commerce identity of `botId`'s persona on `guildId`.
 *
 * `@` rather than `:` because component custom-ids are colon-delimited and
 * already parsed by field (`crv:buy:<dispatch>:<item>`); an id carrying a colon
 * would be a split waiting to go wrong.
 *
 * Rows under these ids deliberately have no `npcs` row — `npcs` is bookkeeping
 * identity. There are no foreign keys on `inventories`/`reputation`, so nothing
 * requires one.
 */
export function npcAt(botId: string, guildId: string): string {
  return `${botId}@${guildId}`;
}
