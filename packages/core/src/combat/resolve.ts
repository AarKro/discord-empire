/**
 * The battle resolver (framework spec §2.6, §5.13).
 *
 * §2.6: "the fight auto-resolves from stats with type advantages providing the
 * strategic layer. No turn-by-turn play — fights can resolve while you're away,
 * and the skill lives in composition." §5.13 adds: "seeded & logged for
 * auditability".
 *
 * So this module is a PURE function: force + encounter + seed in, a full round
 * log out. No DB, no Discord, no clock, no Math.random. That is what makes the
 * audit claim real — a stored battle row can be replayed from its seed and must
 * produce byte-identical rounds. It is also why the whole strategic layer is
 * unit-testable without a database.
 *
 * The player's force fights as a POOLED hp bar rather than as individually
 * tracked stacks. That is a deliberate simplification, not a shortcut: §2.6
 * rules out PvE losses entirely ("no injuries, no raidable losses"), so hp here
 * is only the fight's internal clock — nothing about it survives the battle.
 * Pooling also keeps the monster's type matchup fixed for the whole fight,
 * which keeps the log honest and the replay trivially deterministic.
 */
import { matchupMultiplier, type StatBlock, type UnitType } from "./types.js";

/** Rounds after which the fight is called on remaining hp fraction. Prevents a
 *  pair of evenly-matched, heavily-armoured sides looping forever. */
export const MAX_ROUNDS = 12;

/** Damage swing per round: ±15% around the deterministic figure. */
const VARIANCE_SPREAD = 0.3;
const VARIANCE_FLOOR = 1 - VARIANCE_SPREAD / 2;

/** A troop stack as dispatched — the snapshot stored on `dispatches.force`. */
export interface ForceTroop extends StatBlock {
  unitId?: string;
  unitType: UnitType;
  qty: number;
}

/** The champion, if the player has one riding along. */
export interface ForceChampion extends StatBlock {
  unitId?: string;
  unitType: UnitType;
  level: number;
}

export interface Force {
  troops: ForceTroop[];
  champion?: ForceChampion | null;
}

/** The monster side — one row of `encounter_catalog`. */
export interface Encounter extends StatBlock {
  id: string;
  name: string;
  unitType: UnitType;
}

export interface RoundLog {
  round: number;
  /** Damage the force dealt this round, after matchup, armour and variance. */
  forceDamage: number;
  /** …and what the encounter dealt back. */
  encounterDamage: number;
  forceHp: number;
  encounterHp: number;
  /** The human-readable line rendered into the resolution-log thread. */
  line: string;
}

export interface BattleResult {
  seed: string;
  outcome: "victory" | "defeat";
  rounds: RoundLog[];
  forceHpRemaining: number;
  encounterHpRemaining: number;
}

export interface ResolveInput {
  force: Force;
  encounter: Encounter;
  seed: string;
}

/**
 * FNV-1a over the seed string → a uint32 for the PRNG. Any stable string→int
 * hash would do; what matters is that it is deterministic and spreads adjacent
 * ulids (which share a long timestamp prefix) into unrelated streams.
 */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32 — a small, fast, well-distributed seeded PRNG. Chosen over
 * anything cryptographic because the requirement is reproducibility, not
 * unpredictability: the player is told the seed.
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Armour mitigation: diminishing returns, never full immunity. */
function mitigate(damage: number, def: number): number {
  return (damage * 100) / (100 + Math.max(0, def));
}

/** Every unit in the force, champion included, as flat weighted entries. */
function entries(force: Force): { unitType: UnitType; qty: number; atk: number; def: number; hp: number }[] {
  const all = force.troops.map((t) => ({ unitType: t.unitType, qty: t.qty, atk: t.atk, def: t.def, hp: t.hp }));
  if (force.champion) {
    const c = force.champion;
    all.push({ unitType: c.unitType, qty: 1, atk: c.atk, def: c.def, hp: c.hp });
  }
  return all;
}

/**
 * Resolve a fight. Deterministic in `seed`: the same input always yields the
 * same rounds, which is the property `battles.seed` exists to preserve.
 */
export function resolveBattle({ force, encounter, seed }: ResolveInput): BattleResult {
  const rng = mulberry32(hashSeed(seed));
  const units = entries(force);

  const forceHpTotal = units.reduce((sum, u) => sum + u.qty * u.hp, 0);
  const encounterHpTotal = Math.max(0, encounter.hp);

  // An empty force loses before a blow is struck; a hollow encounter is already
  // beaten. Both are guards rather than simulations — entering the loop with a
  // zero hp pool would divide by zero building the weighted averages below.
  if (forceHpTotal <= 0) {
    return { seed, outcome: "defeat", rounds: [], forceHpRemaining: 0, encounterHpRemaining: encounterHpTotal };
  }
  if (encounterHpTotal <= 0) {
    return { seed, outcome: "victory", rounds: [], forceHpRemaining: forceHpTotal, encounterHpRemaining: 0 };
  }

  // The force's offence: each stack's contribution is scaled by ITS OWN matchup
  // against the monster. This is the strategic layer — sending the countering
  // type is worth more than sending more bodies.
  const forceAttack = units.reduce(
    (sum, u) => sum + u.qty * u.atk * matchupMultiplier(u.unitType, encounter.unitType),
    0,
  );

  // The monster faces a mixed force, so its matchup and the armour it chews
  // through are hp-weighted averages over the composition. Computed once: the
  // force fights as a pooled bar, so the mix never shifts mid-fight.
  const forceDef = units.reduce((sum, u) => sum + u.qty * u.hp * u.def, 0) / forceHpTotal;
  const encounterMatchup =
    units.reduce((sum, u) => sum + u.qty * u.hp * matchupMultiplier(encounter.unitType, u.unitType), 0) /
    forceHpTotal;

  const baseForceDamage = mitigate(forceAttack, encounter.def);
  const baseEncounterDamage = mitigate(encounter.atk * encounterMatchup, forceDef);

  let forceHp = forceHpTotal;
  let encounterHp = encounterHpTotal;
  const rounds: RoundLog[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    // Both sides swing in the same round — a force can be wiped out on the same
    // exchange that fells the monster, which the outcome rule below settles.
    // Draw both rolls unconditionally so the stream stays aligned across replays.
    const forceRoll = VARIANCE_FLOOR + rng() * VARIANCE_SPREAD;
    const encounterRoll = VARIANCE_FLOOR + rng() * VARIANCE_SPREAD;

    const forceDamage = Math.max(1, Math.round(baseForceDamage * forceRoll));
    const encounterDamage = Math.max(1, Math.round(baseEncounterDamage * encounterRoll));

    encounterHp = Math.max(0, encounterHp - forceDamage);
    forceHp = Math.max(0, forceHp - encounterDamage);

    rounds.push({
      round,
      forceDamage,
      encounterDamage,
      forceHp,
      encounterHp,
      line: `Round ${round} — your force strikes for **${forceDamage}**; ${encounter.name} answers for **${encounterDamage}**.`,
    });

    if (encounterHp <= 0 || forceHp <= 0) break;
  }

  // Victory means the field was cleared and someone was left standing on it.
  // Mutual destruction, and a fight still undecided at the round cap with the
  // monster no worse off, both go to the monster — it holds the ground.
  const outcome =
    encounterHp <= 0 && forceHp > 0
      ? "victory"
      : forceHp / forceHpTotal > encounterHp / encounterHpTotal
        ? "victory"
        : "defeat";

  return { seed, outcome, rounds, forceHpRemaining: forceHp, encounterHpRemaining: encounterHp };
}

/** A row of an encounter's loot table (`encounter_catalog.loot`). */
export interface LootEntry {
  item: string;
  qty: number;
  /** Drop probability in [0,1]. */
  chance: number;
}

/**
 * Roll an encounter's loot table. Seeded from the SAME battle seed — §2.6 makes
 * the loot chance the only thing a loss actually costs, so the roll has to be
 * as auditable as the fight itself. The `:loot` suffix forks a stream that is
 * independent of the combat rounds, so re-tuning round variance later can't
 * silently reshuffle historical drops.
 */
export function rollLoot(table: LootEntry[], seed: string): { item: string; qty: number }[] {
  const rng = mulberry32(hashSeed(`${seed}:loot`));
  const won: { item: string; qty: number }[] = [];
  for (const entry of table) {
    // Draw for every entry, including impossible ones, so the stream stays
    // aligned when a table is re-tuned to chance 0 rather than deleted.
    const roll = rng();
    if (entry.qty > 0 && roll < entry.chance) won.push({ item: entry.item, qty: entry.qty });
  }
  return won;
}
