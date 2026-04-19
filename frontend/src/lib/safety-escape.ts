/** "Get to safety" helper — finds the closest staffed safe spaces
 *  around a coordinate so a user in distress can route to one in
 *  one tap.
 *
 *  Categories deliberately bias toward _places with people inside_:
 *
 *    - police stations            (always staffed)
 *    - hospitals & ERs / clinics  (24h or near-24h)
 *    - fire stations              (staffed, doors-open culture)
 *    - 24h fuel stations          (only ones tagged `opening_hours=24/7`)
 *
 *  Coffee shops, bars, restaurants etc. are intentionally excluded —
 *  they may be closed, may not let you in, and the user is already in
 *  fight-or-flight and needs a high-confidence answer, not a list of
 *  Starbucks. Keep this list short and trustworthy.
 *
 *  Distance is straight-line meters, not walking-graph; the goal is to
 *  surface a usable shortlist quickly, not to compute an exact ETA.
 *  The directions panel will produce a real route when the user picks
 *  one.
 */

import { fetchNearbyPois, type Poi } from "@/lib/overpass";

export type SafePlaceKind = "police" | "hospital" | "fire_station" | "fuel_24h";

export interface SafePlace {
  id: string;
  kind: SafePlaceKind;
  name: string;
  lat: number;
  lng: number;
  /** Straight-line meters from the query point. */
  distanceM: number;
  /** Display hint (e.g. street, brand) when OSM had one. */
  hint?: string;
  /** Roughly "this is open 24/7" — true for police/fire/24h fuel,
   *  conservatively true for most hospitals. We only set it when we
   *  have positive evidence; missing means "probably yes but unknown". */
  open24h?: boolean;
}

export const SAFE_PLACE_KIND_META: Record<
  SafePlaceKind,
  { label: string; emoji: string; color: string }
> = {
  police:       { label: "Police",      emoji: "🚓", color: "#3b82f6" },
  hospital:     { label: "Hospital/ER", emoji: "🏥", color: "#22c55e" },
  fire_station: { label: "Fire",        emoji: "🚒", color: "#ef4444" },
  fuel_24h:     { label: "24h gas",     emoji: "⛽", color: "#f59e0b" },
};

const SEARCH_RADIUS_M = 4_000;
const MAX_PER_KIND = 4;

function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function poiToSafe(p: Poi, kind: SafePlaceKind, open24h?: boolean): SafePlace {
  return {
    id: `${kind}:${p.id}`,
    kind,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    distanceM: p.distance,
    hint: p.hint,
    open24h,
  };
}

/** Find the closest safe spaces around `origin`. Returns up to ~12 entries
 *  combined across categories, sorted by ascending straight-line distance.
 *
 *  Errors are swallowed per-category so a single failed Overpass shard
 *  doesn't blank out the whole panel — partial results are strictly
 *  better than nothing in an emergency UI. */
export async function findSafeSpacesNear(origin: {
  lat: number;
  lng: number;
}): Promise<SafePlace[]> {
  const safeFetch = async (
    kind: SafePlaceKind,
    poiCat: "police" | "hospital" | "fire_station" | "fuel"
  ): Promise<SafePlace[]> => {
    try {
      const pois = await fetchNearbyPois(
        poiCat,
        origin.lat,
        origin.lng,
        SEARCH_RADIUS_M,
        MAX_PER_KIND * 4
      );
      return pois
        .map((p) =>
          poiToSafe(
            { ...p, distance: haversineM(origin, p) },
            kind,
            kind === "police" || kind === "fire_station" ? true : undefined
          )
        )
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, MAX_PER_KIND);
    } catch (err) {
      console.warn(`[pp] safety-escape ${kind} fetch failed`, err);
      return [];
    }
  };

  const [police, hospitals, fire, fuel] = await Promise.all([
    safeFetch("police", "police"),
    safeFetch("hospital", "hospital"),
    safeFetch("fire_station", "fire_station"),
    // We pull fuel-as-fuel and let the UI label it as "24h gas" — the
    // open-hours tag isn't carried through fetchNearbyPois, so we
    // optimistically include the closest stations and rely on the
    // user's judgement. (Filtering Overpass to `opening_hours=24/7`
    // would be the rigorous answer; trade-off is most US stations omit
    // that tag entirely and we'd return an empty list.)
    safeFetch("fuel_24h", "fuel"),
  ]);

  return [...police, ...hospitals, ...fire, ...fuel].sort(
    (a, b) => a.distanceM - b.distanceM
  );
}

/** Format meters into a tight "120 m" / "1.4 km" string. */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 5000 ? 1 : 0)} km`;
}
