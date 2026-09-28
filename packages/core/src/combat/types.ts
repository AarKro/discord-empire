/**
 * Unit types and the matchup triangle (framework spec §2.6).
 *
 * Combat is preparation-based: the fight auto-resolves from stats and "type
 * advantages provide the strategic layer". That makes this table the entire
 * strategic surface of the game's combat — the one thing a player reasons about
 * when composing a force. It lives alone in its own module, with no DB and no
 * Discord anywhere near it, so balance tuning has exactly one home and the
 * resolver stays a pure function of it.
 */

/** The three troop types. A classic triangle — no type is dominant. */
export const UNIT_TYPES = ["infantry", "cavalry", "archer"] as const;

export type UnitType = (typeof UNIT_TYPES)[number];

/** True when `value` names a real unit type — the guard `/muster` validates on. */
export function isUnitType(value: string): value is UnitType {
  return (UNIT_TYPES as readonly string[]).includes(value);
}

/**
 * Who beats whom: spears brace against horse, horse rides down bowmen, bowmen
 * shoot infantry before it closes. Each type has exactly one prey and one
 * predator, so no composition is strictly best.
 */
const BEATS: Record<UnitType, UnitType> = {
  infantry: "cavalry",
  cavalry: "archer",
  archer: "infantry",
};

/** Damage multiplier applied when `attacker` holds the type advantage. */
export const ADVANTAGE = 1.5;

/** …and when it is on the wrong end of one. Deliberately the inverse of
 *  ADVANTAGE, so a mirrored pair of matchups is a wash rather than a net
 *  gain or loss of damage across the field. */
export const DISADVANTAGE = 1 / ADVANTAGE;

/**
 * The multiplier on `attacker`'s damage against `defender`: ADVANTAGE when it
 * counters, DISADVANTAGE when it is countered, 1 for the neutral pairing (which
 * includes same-vs-same).
 */
export function matchupMultiplier(attacker: UnitType, defender: UnitType): number {
  if (BEATS[attacker] === defender) return ADVANTAGE;
  if (BEATS[defender] === attacker) return DISADVANTAGE;
  return 1;
}

/** The stat block a freshly mustered troop of each type carries. */
export interface StatBlock {
  atk: number;
  def: number;
  hp: number;
}

/**
 * Base stats per type, priced so the triangle — not raw numbers — decides
 * fights: archers hit hardest and fold fastest, infantry is the anvil, cavalry
 * sits between. Totals are close enough that a bad matchup outweighs the gap.
 */
export const BASE_STATS: Record<UnitType, StatBlock> = {
  infantry: { atk: 8, def: 6, hp: 30 },
  cavalry: { atk: 11, def: 4, hp: 24 },
  archer: { atk: 14, def: 2, hp: 18 },
};

/** The gold a single troop of `type` costs to muster (§2.5 — cost scales with punch). */
export const MUSTER_COST: Record<UnitType, number> = {
  infantry: 10,
  cavalry: 14,
  archer: 18,
};

/**
 * The champion's stat block at a given level (§2.6): the player's single hero
 * unit and personal stake in every fight. Equipment and skills are deferred —
 * when they land they multiply this block rather than replace it.
 */
export function championStats(level: number): StatBlock {
  return {
    atk: 12 + 4 * (level - 1),
    def: 8 + 3 * (level - 1),
    hp: 60 + 20 * (level - 1),
  };
}

/** The bonus a piece of gear adds — its slice of the gear catalog (§2.6). */
export type GearBonus = StatBlock;

/**
 * The champion's fighting block with gear on (§2.6: power flows from
 * "equipment and blueprints (champion gear)"). Flat, additive bonuses on top of
 * the tier-derived base — simple enough that a player can do the sum in their
 * head when choosing what to wear.
 */
export function championWithGear(base: StatBlock, gear: readonly GearBonus[]): StatBlock {
  return gear.reduce((acc, g) => ({ atk: acc.atk + g.atk, def: acc.def + g.def, hp: acc.hp + g.hp }), { ...base });
}
