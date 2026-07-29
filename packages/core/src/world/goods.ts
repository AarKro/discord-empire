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
import type { Continents, ShopItem } from "@empire/content-schemas";

/** What a foreign curio costs, as a multiple of its home price. */
export const IMPORT_PRICE_MULTIPLIER = 3;

/** How many units of a foreign curio a merchant carries. */
export const IMPORT_STOCK = 2;

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
