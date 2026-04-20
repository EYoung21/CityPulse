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
  | "coffee"
  | "police"
  | "fire_station"
  | "charging_station"
  | "toilets";

/** Persistent map-overlay categories (subset of PoiCategory). These are
 *  the always-on "safety POIs" surfaced as a togglable layer alongside
 *  the heatmap, distinct from the click-driven NearbyPois chips. */
export type SafetyPoiCategory = "hospital" | "police" | "fire_station";

/** Convenience POI overlays — separate from safety POIs both visually
 *  (lighter color palette) and intent-wise (driver/walker errands vs
 *  emergency reference points). Same fetch infrastructure, different
 *  toggle group in the Layers menu. */
export type NearbyPoiCategory = "fuel" | "food" | "coffee" | "atm" | "parking" | "charging_station" | "toilets";

export const SAFETY_POI_CATEGORIES: { id: SafetyPoiCategory; label: string; emoji: string; color: string }[] = [
  { id: "hospital",     label: "Hospital",  emoji: "🏥", color: "#22c55e" },
  { id: "police",       label: "Police",    emoji: "🚓", color: "#3b82f6" },
  { id: "fire_station", label: "Fire",      emoji: "🚒", color: "#ef4444" },
];

export const NEARBY_POI_CATEGORIES: { id: NearbyPoiCategory; label: string; emoji: string; color: string; glyph: string }[] = [
  { id: "fuel",             label: "Gas",       emoji: "⛽", color: "#f97316", glyph: "G" },
  { id: "charging_station", label: "EV charge", emoji: "🔌", color: "#10b981", glyph: "E" },
  { id: "food",             label: "Food",      emoji: "🍽️", color: "#ef4444", glyph: "F" },
  { id: "coffee",           label: "Coffee",    emoji: "☕", color: "#a855f7", glyph: "C" },
  { id: "parking",          label: "Parking",   emoji: "🅿️", color: "#3b82f6", glyph: "P" },
  { id: "atm",              label: "ATM",       emoji: "🏧", color: "#0ea5e9", glyph: "$" },
  { id: "toilets",          label: "Restroom",  emoji: "🚻", color: "#64748b", glyph: "R" },
];

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
  /** Raw OSM `opening_hours` tag value, when contributors filled it
   *  in. Most US POIs leave this blank — when present it can be a
   *  full schedule string ("Mo-Fr 09:00-17:00; Sa 10:00-14:00"),
   *  the special token "24/7", or freeform text. We surface it as-is
   *  to consumers; `lib/opening-hours` interprets a useful subset. */
  openingHours?: string;
  /** Optional contact info from OSM tags — surfaced as Call / Site
   *  CTA buttons on POI rows when present. */
  phone?: string;
  website?: string;
  /** OSM `wheelchair` tag (`yes` / `limited` / `no`). Surfaced as a
   *  small accessibility badge so users can see at a glance whether a
   *  shop is step-free without opening the place card. We don't
   *  invent values: undefined means contributors haven't tagged it
   *  yet, which is far more common than `no`. */
  wheelchair?: "yes" | "limited" | "no";
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
  food:             '["amenity"~"restaurant|fast_food|food_court|cafe"]',
  coffee:           '["amenity"="cafe"]',
  fuel:             '["amenity"="fuel"]',
  hospital:         '["amenity"~"hospital|clinic|doctors"]',
  pharmacy:         '["amenity"="pharmacy"]',
  parking:          '["amenity"~"parking|parking_space"]',
  atm:              '["amenity"="atm"]',
  police:           '["amenity"="police"]',
  fire_station:     '["amenity"="fire_station"]',
  charging_station: '["amenity"="charging_station"]',
  // Restrooms are tagged a few different ways; "toilets" is the most
  // common, but restaurants/parks also expose `["toilets"="yes"]`. We
  // restrict to the dedicated amenity tag to avoid mapping every
  // McDonald's just because it has a bathroom.
  toilets:          '["amenity"="toilets"]',
};

/** Normalize the OSM `wheelchair` tag to one of three known values.
 *  We deliberately don't pass through unknown values (`designated`,
 *  `permissive`, etc.) — they're rare in practice and conflating them
 *  with "yes" would be misleading. */
function parseWheelchair(value: string | undefined): "yes" | "limited" | "no" | undefined {
  if (value === "yes" || value === "limited" || value === "no") return value;
  return undefined;
}

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
            openingHours: tags["opening_hours"] || undefined,
            phone: tags.phone || tags["contact:phone"] || undefined,
            website: tags.website || tags["contact:website"] || undefined,
            wheelchair: parseWheelchair(tags.wheelchair),
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

/** Bounding-box variant of fetchNearbyPois. Used by the persistent
 *  Safety-POI overlay so the markers fill the visible viewport rather
 *  than a fixed radius. Cached & deduped the same way. */
export async function fetchPoisInBounds(
  category: PoiCategory,
  bounds: { south: number; west: number; north: number; east: number },
  limit = 80
): Promise<Poi[]> {
  // Snap to ~3 decimal places (~110m at the equator) so small map jitter
  // doesn't bypass the cache. Wider categories like food would still hit
  // the network often, but safety POIs are sparse and stable enough to
  // benefit a lot.
  const k = (n: number) => n.toFixed(3);
  const cKey = `bbox:${category}:${k(bounds.south)},${k(bounds.west)},${k(bounds.north)},${k(bounds.east)}`;

  const mem = memCache.get(cKey);
  if (mem && Date.now() - mem.at < CACHE_TTL_MS) return mem.data.slice(0, limit);
  const sess = loadSessionCache(cKey);
  if (sess) {
    memCache.set(cKey, { at: Date.now(), data: sess });
    return sess.slice(0, limit);
  }

  const filter = FILTERS[category];
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const query = `[out:json][timeout:15];
(
  node${filter}(${bbox});
  way${filter}(${bbox});
);
out center ${limit * 2};`;

  // Approx viewport center for the optional "distance" sort; not strictly
  // meaningful for bbox queries but consumers expect the field.
  const cLat = (bounds.south + bounds.north) / 2;
  const cLng = (bounds.west + bounds.east) / 2;

  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) { lastErr = new Error(`Overpass ${res.status}`); continue; }
      const data = (await res.json()) as { elements?: OverpassElement[] };
      const pois = (data.elements ?? [])
        .map((el): Poi | null => {
          const elLat = el.lat ?? el.center?.lat;
          const elLng = el.lon ?? el.center?.lon;
          if (elLat == null || elLng == null) return null;
          const tags = el.tags ?? {};
          const name =
            tags.name || tags.brand || tags.operator ||
            // Many overlay categories are commonly tagged without a
            // `name` (parking lots, ATMs in bank ATMs, public restrooms).
            // Fall back to a category label so they still get a marker
            // — discoverability matters more than a precise vendor name.
            (category === "police"          ? "Police station" :
             category === "fire_station"    ? "Fire station"   :
             category === "parking"         ? "Parking"        :
             category === "atm"             ? "ATM"            :
             category === "toilets"         ? "Restroom"       :
             category === "charging_station" ? "EV charger"    :
             category === "fuel"            ? "Gas station"    :
             null);
          if (!name) return null;
          return {
            id: `${el.type}/${el.id}`,
            name,
            category,
            lat: elLat,
            lng: elLng,
            distance: haversineM(cLat, cLng, elLat, elLng),
            hint: tags["addr:street"] || tags.operator || tags.brand || undefined,
            openingHours: tags["opening_hours"] || undefined,
            phone: tags.phone || tags["contact:phone"] || undefined,
            website: tags.website || tags["contact:website"] || undefined,
            wheelchair: parseWheelchair(tags.wheelchair),
          };
        })
        .filter((p): p is Poi => p !== null)
        .slice(0, limit);

      memCache.set(cKey, { at: Date.now(), data: pois });
      saveSessionCache(cKey, pois);
      return pois;
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn("[pp] overpass bbox failed", lastErr);
  return [];
}

/** Tagged-place metadata returned by `fetchPlaceAtPoint` — a strict
 *  subset of `Poi` minus the category union, since at the long-press
 *  call site the POI may be a shop, amenity, or tourism feature and
 *  forcing it into one of our seven UI categories would be lossy. */
export interface PlaceAtPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distanceM: number;
  phone?: string;
  website?: string;
  openingHours?: string;
  wheelchair?: "yes" | "limited" | "no";
  /** Raw OSM kind for display ("Cafe", "Pharmacy", "Bank") — derived
   *  from the most specific tag we recognize. */
  kind?: string;
}

const placeAtMemCache = new Map<string, { at: number; data: PlaceAtPoint | null }>();

/** Look up the nearest *named* tagged place within `radiusM` meters of
 *  a point. Used by DroppedPinCard so a long-press that lands on (or
 *  next to) a tagged business surfaces the same Call/Site CTAs that
 *  NearbyPois rows offer.
 *
 *  We constrain the Overpass query to nodes/ways with both a `name`
 *  tag AND one of the recognized place keys (`amenity`, `shop`,
 *  `tourism`, `office`, `leisure`, `healthcare`) — without that
 *  constraint the result set explodes (every named building, alley,
 *  monument). 30m default radius matches the typical sidewalk-to-
 *  storefront distance; bigger lots like supermarkets are caught by
 *  the way center being inside that radius. */
export async function fetchPlaceAtPoint(
  lat: number,
  lng: number,
  radiusM = 30
): Promise<PlaceAtPoint | null> {
  const key = `place:${lat.toFixed(5)},${lng.toFixed(5)}:${radiusM}`;
  const mem = placeAtMemCache.get(key);
  if (mem && Date.now() - mem.at < CACHE_TTL_MS) return mem.data;

  // Reuse the bbox/named cache namespace for sessionStorage but key
  // separately so the type's safe to read back.
  if (typeof sessionStorage !== "undefined") {
    try {
      const raw = sessionStorage.getItem(`pp:overpass:${key}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { at: number; data: PlaceAtPoint | null };
        if (Date.now() - parsed.at < CACHE_TTL_MS) {
          placeAtMemCache.set(key, parsed);
          return parsed.data;
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Six unioned subqueries — one per "this is a real place" key
  // family. We omit `building=*` because most buildings are unnamed
  // outlines that contain a separate amenity node, and querying both
  // would just dedupe back down to the amenity anyway.
  const filters = ['["amenity"]', '["shop"]', '["tourism"]', '["office"]', '["leisure"]', '["healthcare"]'];
  const around = `(around:${radiusM},${lat},${lng})`;
  const subqueries = filters
    .flatMap((f) => [`node["name"]${f}${around};`, `way["name"]${f}${around};`])
    .join("\n  ");
  const query = `[out:json][timeout:10];
(
  ${subqueries}
);
out center 12;`;

  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) { lastErr = new Error(`Overpass ${res.status}`); continue; }
      const data = (await res.json()) as { elements?: OverpassElement[] };
      const ranked = (data.elements ?? [])
        .map((el): PlaceAtPoint | null => {
          const elLat = el.lat ?? el.center?.lat;
          const elLng = el.lon ?? el.center?.lon;
          if (elLat == null || elLng == null) return null;
          const tags = el.tags ?? {};
          const name = tags.name || tags.brand || tags.operator;
          if (!name) return null;
          // Pick the most specific tag for the "kind" label. Order
          // matters — shop is more specific than amenity for retail,
          // healthcare beats amenity for clinics, etc.
          const kindRaw =
            tags.shop || tags.healthcare || tags.amenity || tags.tourism ||
            tags.office || tags.leisure;
          const kind = kindRaw
            ? kindRaw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
            : undefined;
          return {
            id: `${el.type}/${el.id}`,
            name,
            lat: elLat,
            lng: elLng,
            distanceM: haversineM(lat, lng, elLat, elLng),
            phone: tags.phone || tags["contact:phone"] || undefined,
            website: tags.website || tags["contact:website"] || undefined,
            openingHours: tags["opening_hours"] || undefined,
            wheelchair: parseWheelchair(tags.wheelchair),
            kind,
          };
        })
        .filter((p): p is PlaceAtPoint => p !== null)
        .sort((a, b) => a.distanceM - b.distanceM);

      const nearest = ranked[0] ?? null;
      placeAtMemCache.set(key, { at: Date.now(), data: nearest });
      if (typeof sessionStorage !== "undefined") {
        try {
          sessionStorage.setItem(
            `pp:overpass:${key}`,
            JSON.stringify({ at: Date.now(), data: nearest })
          );
        } catch { /* over quota — ignore */ }
      }
      return nearest;
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn("[pp] overpass place-at-point failed", lastErr);
  return null;
}
