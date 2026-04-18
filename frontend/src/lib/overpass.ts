/** Overpass API client for nearby Points-of-Interest.
 *
 *  Uses the public Overpass instance (rate-limited but free). Results are
 *  cached in-memory + sessionStorage by category+lat+lng+radius for the life
 *  of the tab so repeated taps on the same area are instant.
 *
 *  We deliberately request a tight radius (default 800m) and cap to 25 hits
 *  to keep Overpass load — and our render cost — predictable. */

export type PoiCategory =
  | "food"
  | "fuel"
  | "hospital"
  | "pharmacy"
  | "parking"
  | "atm"
  | "coffee";

export interface Poi {
  id: string;
  name: string;
  category: PoiCategory;
  lat: number;
  lng: number;
  /** meters from the query point */
  distance: number;
  /** Optional address-ish hint pulled from tags. */
  hint?: string;
}

export const POI_CATEGORIES: { id: PoiCategory; label: string; emoji: string }[] = [
  { id: "food",     label: "Food",      emoji: "🍽️" },
  { id: "coffee",   label: "Coffee",    emoji: "☕" },
  { id: "fuel",     label: "Gas",       emoji: "⛽" },
  { id: "hospital", label: "Hospital",  emoji: "🏥" },
  { id: "pharmacy", label: "Pharmacy",  emoji: "💊" },
  { id: "parking",  label: "Parking",   emoji: "🅿️" },
  { id: "atm",      label: "ATM",       emoji: "🏧" },
];

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** OSM filter expression per category. We OR amenity, shop, and (rare)
 *  tourism keys to capture the way most contributors tag each POI type. */
const FILTERS: Record<PoiCategory, string> = {
  food:     '["amenity"~"restaurant|fast_food|food_court|cafe"]',
  coffee:   '["amenity"="cafe"]',
  fuel:     '["amenity"="fuel"]',
  hospital: '["amenity"~"hospital|clinic|doctors"]',
  pharmacy: '["amenity"="pharmacy"]',
  parking:  '["amenity"~"parking|parking_space"]',
  atm:      '["amenity"="atm"]',
};

const memCache = new Map<string, { at: number; data: Poi[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheKey(cat: PoiCategory, lat: number, lng: number, r: number): string {
  return `${cat}:${lat.toFixed(4)},${lng.toFixed(4)}:${r}`;
}

function loadSessionCache(key: string): Poi[] | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`pp:overpass:${key}`);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw) as { at: number; data: Poi[] };
    if (Date.now() - at > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function saveSessionCache(key: string, data: Poi[]): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      `pp:overpass:${key}`,
      JSON.stringify({ at: Date.now(), data })
    );
  } catch {
    /* over quota — ignore */
  }
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export async function fetchNearbyPois(
  category: PoiCategory,
  lat: number,
  lng: number,
  radiusM = 800,
  limit = 25
): Promise<Poi[]> {
  const key = cacheKey(category, lat, lng, radiusM);

  const mem = memCache.get(key);
  if (mem && Date.now() - mem.at < CACHE_TTL_MS) return mem.data.slice(0, limit);

  const sess = loadSessionCache(key);
  if (sess) {
    memCache.set(key, { at: Date.now(), data: sess });
    return sess.slice(0, limit);
  }

  const filter = FILTERS[category];
  const query = `[out:json][timeout:15];
(
  node${filter}(around:${radiusM},${lat},${lng});
  way${filter}(around:${radiusM},${lat},${lng});
);
out center ${limit * 2};`;

  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        lastErr = new Error(`Overpass ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { elements?: OverpassElement[] };
      const pois = (data.elements ?? [])
        .map((el): Poi | null => {
          const elLat = el.lat ?? el.center?.lat;
          const elLng = el.lon ?? el.center?.lon;
          if (elLat == null || elLng == null) return null;
          const tags = el.tags ?? {};
          const name = tags.name || tags.brand || tags.operator;
          if (!name) return null;
          return {
            id: `${el.type}/${el.id}`,
            name,
            category,
            lat: elLat,
            lng: elLng,
            distance: haversineM(lat, lng, elLat, elLng),
            hint: tags["addr:street"] || tags.cuisine || tags.brand || undefined,
          };
        })
        .filter((p): p is Poi => p !== null)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);

      memCache.set(key, { at: Date.now(), data: pois });
      saveSessionCache(key, pois);
      return pois;
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn("[pp] overpass failed", lastErr);
  return [];
}
