"use client";

/** OpenStreetMap POI (Point-of-Interest) search via Overpass API.
 *
 *  Nominatim (which our address search already uses) is great at
 *  resolving "1600 Market St" → coords, but weak at "all coffee shops
 *  near me." Overpass is the right tool for category queries because
 *  it speaks OSM's tag schema directly (amenity=cafe, shop=hospital,
 *  etc.).
 *
 *  All requests go through /api/poi so the browser never hits
 *  Overpass directly. That gives us:
 *    * a single User-Agent the Overpass operators can identify and
 *      throttle us as one app instead of every visitor's IP;
 *    * shared edge cache so 5 users tapping "Coffee" at the same
 *      airport = 1 upstream request;
 *    * room to add provider fallback (overpass-api.de →
 *      overpass.kumi.systems) when one instance is down.
 */

export interface PoiCategory {
  /** URL-safe slug we pass to /api/poi?category=… */
  key: string;
  /** Short label shown on the chip. */
  label: string;
  /** Overpass tag filter, e.g. ["amenity=cafe"]. Multiple = union. */
  tags: string[];
}

export const POI_CATEGORIES: readonly PoiCategory[] = [
  { key: "coffee",     label: "Coffee",     tags: ["amenity=cafe"] },
  { key: "food",       label: "Food",       tags: ["amenity=restaurant", "amenity=fast_food"] },
  { key: "hospital",   label: "Hospital",   tags: ["amenity=hospital"] },
  { key: "pharmacy",   label: "Pharmacy",   tags: ["amenity=pharmacy"] },
  { key: "gas",        label: "Gas",        tags: ["amenity=fuel"] },
  { key: "parking",    label: "Parking",    tags: ["amenity=parking"] },
  { key: "atm",        label: "ATM",        tags: ["amenity=atm", "amenity=bank"] },
  { key: "transit",    label: "Transit",    tags: ["public_transport=station", "railway=station"] },
] as const;

export function poiCategoryByKey(key: string): PoiCategory | undefined {
  return POI_CATEGORIES.find((c) => c.key === key);
}

export interface PoiResult {
  /** Display name (uses OSM `name` tag; falls back to category label). */
  name: string;
  lat: number;
  lng: number;
  /** Optional secondary line — usually street or `addr:street`. */
  subtitle?: string;
  /** Straight-line distance from the query origin, in meters. Filled
   *  in client-side after we know the user's coords. */
  meters?: number;
}

/** Search POIs of a category within a radius of (lat, lng). Returns
 *  results sorted by distance, capped at `limit`. */
export async function searchPOI(
  categoryKey: string,
  lat: number,
  lng: number,
  opts: { radiusM?: number; limit?: number; signal?: AbortSignal } = {}
): Promise<PoiResult[]> {
  const radiusM = opts.radiusM ?? 2500;
  const limit = opts.limit ?? 25;
  const params = new URLSearchParams({
    category: categoryKey,
    lat: lat.toFixed(6),
    lng: lng.toFixed(6),
    radius: String(radiusM),
    limit: String(limit),
  });
  const r = await fetch(`/api/poi?${params}`, {
    signal: opts.signal,
    // Server-side route handles caching; client should pass through.
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`POI proxy ${r.status}`);
  const data = (await r.json()) as { results?: PoiResult[] };
  return data.results ?? [];
}
