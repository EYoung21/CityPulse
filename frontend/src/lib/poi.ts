"use client";

/** Nearby POI (Point-of-Interest) search.
 *
 *  Primary provider: TomTom Search via /api/place-search so nearby
 *  category chips get Google-Maps-style POIs with contact/details when
 *  the server key is configured. Fallback: /api/poi Overpass proxy,
 *  which keeps the shelf useful in keyless/local deployments.
 */

import type { GeoResult } from "@/lib/search";
import { getCurrentCity } from "@/lib/pulse-cities";

export interface PoiCategory {
  /** URL-safe slug we pass to /api/poi?category=… */
  key: string;
  /** Short label shown on the chip. */
  label: string;
  /** Natural-language term sent to TomTom POI search. */
  tomtomQuery: string;
  /** Overpass tag filter, e.g. ["amenity=cafe"]. Multiple = union. */
  tags: string[];
}

export const POI_CATEGORIES: readonly PoiCategory[] = [
  { key: "coffee",     label: "Coffee",     tomtomQuery: "coffee",          tags: ["amenity=cafe"] },
  { key: "food",       label: "Food",       tomtomQuery: "restaurant",      tags: ["amenity=restaurant", "amenity=fast_food"] },
  { key: "hospital",   label: "Hospital",   tomtomQuery: "hospital",        tags: ["amenity=hospital"] },
  { key: "pharmacy",   label: "Pharmacy",   tomtomQuery: "pharmacy",        tags: ["amenity=pharmacy"] },
  { key: "gas",        label: "Gas",        tomtomQuery: "gas station",     tags: ["amenity=fuel"] },
  { key: "parking",    label: "Parking",    tomtomQuery: "parking",         tags: ["amenity=parking"] },
  { key: "atm",        label: "ATM",        tomtomQuery: "atm",             tags: ["amenity=atm", "amenity=bank"] },
  { key: "transit",    label: "Transit",    tomtomQuery: "transit station", tags: ["public_transport=station", "railway=station"] },
] as const;

export function poiCategoryByKey(key: string): PoiCategory | undefined {
  return POI_CATEGORIES.find((c) => c.key === key);
}

export interface PoiResult {
  /** Display name (uses OSM `name` tag; falls back to category label). */
  name: string;
  lat: number;
  lng: number;
  display_name?: string;
  address?: string;
  category?: string;
  categories?: string[];
  phone?: string;
  website?: string;
  openingHours?: unknown;
  provider?: "tomtom" | "nominatim" | "overpass";
  entityId?: string;
  /** Optional secondary line — usually street or `addr:street`. */
  subtitle?: string;
  /** Straight-line distance from the query origin, in meters. Filled
   *  in client-side after we know the user's coords. */
  meters?: number;
}

function toPoiResult(result: GeoResult): PoiResult {
  return {
    name: result.name?.trim() || result.display_name.split(",")[0]?.trim() || "Place",
    lat: result.lat,
    lng: result.lng,
    display_name: result.display_name,
    address: result.address,
    category: result.category,
    categories: result.categories,
    phone: result.phone,
    website: result.website,
    openingHours: result.openingHours,
    provider: result.provider ?? result.source,
    entityId: result.entityId,
    subtitle: [result.category, result.address].filter(Boolean).join(" · ") || undefined,
    meters: result.distanceM,
  };
}

async function searchTomTomPOI(
  categoryKey: string,
  lat: number,
  lng: number,
  opts: { radiusM?: number; limit?: number; signal?: AbortSignal } = {}
): Promise<PoiResult[]> {
  const cat = poiCategoryByKey(categoryKey);
  if (!cat) return [];
  const radiusM = opts.radiusM ?? 2500;
  const limit = opts.limit ?? 25;
  const city = getCurrentCity();
  const params = new URLSearchParams({
    category: cat.tomtomQuery,
    city: city.slug,
    lat: lat.toFixed(6),
    lng: lng.toFixed(6),
    radius: String(radiusM),
    limit: String(limit),
  });

  const r = await fetch(`/api/place-search?${params}`, {
    signal: opts.signal,
    cache: "no-store",
  });
  if (!r.ok) return [];
  const data = (await r.json()) as { results?: GeoResult[] };
  return (data.results ?? []).map(toPoiResult);
}

async function searchOverpassPOI(
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
  return (data.results ?? []).map((p) => ({ ...p, provider: "overpass" as const }));
}

/** Search POIs of a category within a radius of (lat, lng). Returns
 *  results sorted by distance, capped at `limit`. */
export async function searchPOI(
  categoryKey: string,
  lat: number,
  lng: number,
  opts: { radiusM?: number; limit?: number; signal?: AbortSignal } = {}
): Promise<PoiResult[]> {
  try {
    const tomtom = await searchTomTomPOI(categoryKey, lat, lng, opts);
    if (tomtom.length > 0) return tomtom;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
  }
  return searchOverpassPOI(categoryKey, lat, lng, opts);
}
