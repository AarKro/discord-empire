/**
 * Local trade goods (framework spec §2.5) — the regional view of a shop item.
 *
 * §2.5: "One global currency, plus continent-local trade goods (items carry an
 * `origin_continent`; the market is global but supply is not — geography creates
 * price differences worth traveling for)."
 *
 * The origin is expressed against a continent's existing `resource_bias`
 * (highlands / harbor / wildwood in continents.yaml) rather than a guild id, so
 * the shop file stays readable content and never has to name an env placeholder.
 *
 * A merchant therefore sells three kinds of ware:
 *   - UBIQUITOUS (no `origin`) — bread, permits: the same everywhere, on purpose.
 *   - LOCAL (`origin` matches the continent) — deep stock at base price.
 *   - IMPORTED (anything else) — dear and scarce, framed in the stall as the
 *     merchant's own travels. This is deliberately a shop WINDOW, not a supply:
 *     two units at triple price advertise what exists abroad and make the case
 *     for travelling or posting a caravan, which is the only way to reach that
 *     continent's real stock at its real price.
 *
 * Pure: no DB, no clock, no Discord — the seeding path, the stall render and the
 * charge path all read the same function, so a price can't be right in one and
 * wrong in another.
 */
import type { Continents, ShopBuy, ShopItem } from "@empire/content-schemas";

/** What a foreign curio costs, as a multiple of its home price. */
export const IMPORT_PRICE_MULTIPLIER = 3;

/** How many units of a foreign curio a merchant carries. */
export const IMPORT_STOCK = 2;

/**
 * The level an `unlimited` ware is held at, and the level it is topped back up
 * from.
 *
 * THIS IS A HIGH-WATER MARK, NOT INFINITY, and the distinction is deliberate.
 * `executeTrade`'s stock guard is `WHERE qty >= :qty` against a real row, so a
 * genuinely infinite ware would mean special-casing the atomic contract — the one
 * thing this codebase protects hardest. What actually changed versus the old
 * hardcoded 1,000,000 seeds is not the number: it is that a REPLENISH PATH now
 * exists, so a permit token can no longer be drained to zero and take every
 * build, research and muster in the realm down with it.
 *
 * The floor exists to keep the ledger quiet: topping up only below it means one
 * audited row per ~990k units sold rather than one per sale.
 */
export const UNLIMITED_STOCK = 1_000_000;
export const UNLIMITED_FLOOR = 10_000;

/** A shop item as one continent sees it. */
export interface RegionalItem {
  price: number;
  /** The hidden haggle floor (§5.4), scaled the same way the price is. */
  floorPrice: number | undefined;
  stock: number;
  /** True when this ware is from somewhere else — the stall marks these. */
  imported: boolean;
}

/**
 * The `resource_bias` of the continent on `guildId`, or null when the guild
 * isn't a known continent. Null means "no region", which `regionalItem` treats
 * as nothing being local — the safe direction, since it can only make a ware
 * look imported, never conjure cheap stock.
 */
export function regionOf(continents: Continents, guildId: string | null | undefined): string | null {
  if (!guildId) return null;
  return continents.continents[guildId]?.resource_bias ?? null;
}

/** How `item` is sold in `region`. */
export function regionalItem(item: ShopItem, region: string | null): RegionalItem {
  // Untagged wares are ubiquitous: sold identically on every continent.
  if (!item.origin) {
    return { price: item.base_price, floorPrice: item.floor_price, stock: item.stock, imported: false };
  }
  if (item.origin === region) {
    return { price: item.base_price, floorPrice: item.floor_price, stock: item.stock, imported: false };
  }
  // The floor scales with the price, or haggling an import down would reach the
  // ware's HOME floor and quietly undo the premium.
  return {
    price: item.base_price * IMPORT_PRICE_MULTIPLIER,
    floorPrice: item.floor_price === undefined ? undefined : item.floor_price * IMPORT_PRICE_MULTIPLIER,
    stock: IMPORT_STOCK,
    imported: true,
  };
}

/**
 * The share of a good's REGIONAL price a merchant pays to buy it (§2.5
 * buy-back). Below 1 so buying from a merchant and selling straight back always
 * loses; the regional price carries the import premium, so a good sold where it
 * isn't local fetches IMPORT_PRICE_MULTIPLIER × this — which is what makes
 * hauling goods abroad (by caravan or on foot) worth the trip.
 */
export const BUYBACK_RATE = 0.5;

/** Gold a merchant in `region` pays for ONE unit of `good` (never 0 for a priced good). */
export function buybackPrice(good: ShopBuy, region: string | null): number {
  // Priced exactly as a shelf ware would be, so the two can never disagree.
  const { price } = regionalItem({ ...good, stock: 0 }, region);
  return Math.max(1, Math.floor(price * BUYBACK_RATE));
}

export interface RestockInput {
  /** What the shelf holds right now. */
  currentQty: number;
  /** The ceiling — this ware's REGIONAL stock, so a curio refills toward 2. */
  cap: number;
  /** Whole restock intervals elapsed since the last pass (catch-up after downtime). */
  intervals: number;
}

/**
 * How many units to add to a shelf, or 0 to leave it alone (§2.5, §3
 * `stock.restocked`).
 *
 * Pure, and the single place the policy lives — the sweep only decides WHEN to
 * ask. Three rules:
 *   - `unlimited` wares are held near their high-water mark and ignore the rate.
 *   - a ware with NO rate never returns. That is what keeps a one-of-a-kind rare
 *     genuinely gone once bought, rather than respawning on the hour.
 *   - otherwise the rate accrues per elapsed interval but is clamped to the cap,
 *     so a week of downtime refills a shelf exactly full and never past it.
 */
export function restockAmount(item: ShopItem, { currentQty, cap, intervals }: RestockInput): number {
  if (item.unlimited) return currentQty < UNLIMITED_FLOOR ? UNLIMITED_STOCK - currentQty : 0;
  if (!item.restock || intervals <= 0) return 0;
  // A shelf already at or over its cap is left alone — never a negative "restock",
  // which would turn a sweep into a silent confiscation.
  return Math.max(0, Math.min(item.restock * intervals, cap - currentQty));
}
