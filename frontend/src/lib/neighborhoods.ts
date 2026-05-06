import type { Incident } from "./api";
import { getCurrentCity } from "./pulse-cities";

/**
 * Per-city neighborhood registry.
 *
 * Each neighborhood can carry either an axis-aligned bounding box
 * (legacy, fast, but inaccurate at boundaries) or a true GeoJSON
 * polygon (accurate, supports overlap-free city dashboards). Helpers
 * below auto-prefer polygon when present and fall back to bbox.
 *
 * The registry is keyed by city slug so this module works across all
 * Pulse deployments. Adding a new city is data-only: drop GeoJSON
 * polygon coordinates into `CITY_NEIGHBORHOODS["sf"]` etc. — no code
 * changes required.
 *
 * Polygon coordinates follow the GeoJSON convention:
 *   `Array<Array<[lng, lat]>>`
 * Where outer array is the polygon, inner arrays are linear rings,
 * and each ring is a closed list of `[lng, lat]` points (first ==
 * last). Single-ring polygons (no holes) are the common case.
 */

export type LngLatRing = [number, number][];

export interface Neighborhood {
  name: string;
  slug: string;
  /** Centroid for label placement / "fly to" actions. */
  center: { lat: number; lng: number };
  /** Axis-aligned bounding box. Always present so legacy callers
   *  (heatmap clip, dashboard rect) keep working without a polygon. */
  bounds: { north: number; south: number; east: number; west: number };
  /** Optional GeoJSON polygon ring(s), `[ [lng,lat], … ]`. When set,
   *  point-in-polygon takes priority over bbox so adjacent
   *  neighborhoods (e.g. Fishtown vs Kensington) don't overlap. */
  polygon?: LngLatRing[];
}

// Existing Philadelphia data — every entry has a bbox for the legacy
// renderer; once we wire OpenDataPhilly's neighborhood GeoJSON into
// this file the `polygon` field will be filled in. No code change is
// required to start using polygons elsewhere — the helpers below will
// pick polygon over bbox automatically.
// Philly neighborhoods are now lazy-loaded from public/neighborhoods/philly.json
// (12 real-polygon districts built from OpenDataPhilly/click_that_hood GeoJSON data).
// Keeping the constant removed avoids bundling stale bbox data into the JS.

/** City-keyed registry. Add an entry per Pulse city as polygon data
 *  becomes available. Empty entries are valid — `getNeighborhood`
 *  just returns null in that city, which is the correct behavior
 *  ("no neighborhood scoring for this city yet").
 *
 *  Polygons are *lazy-loaded* per active city via `loadCityNeighborhoods`
 *  below — at startup this map only carries Philly (which is bundled
 *  inline) and empty placeholders for the rest. SF/NYC/etc. pop in
 *  once their JSON file finishes downloading.
 */
const CITY_NEIGHBORHOODS: Record<string, Neighborhood[]> = {
  philly: [],
  sf: [],
  nyc: [],
  chattanooga: [],
  cle: [],
  cha: [],
  charlotte: [],
};

/** Cities that have a `<slug>.json` file shipped under
 *  `frontend/public/neighborhoods/`. Add a slug here when you drop a
 *  new file in. Keep this in sync with the public directory. */
const CITIES_WITH_LAZY_DATA = new Set<string>(["sf", "nyc", "philly", "chattanooga"]);

/** Per-city load promises so concurrent calls share one network round
 *  trip. Cleared on failure so a transient blip doesn't permanently
 *  poison the city. */
const _loadPromises: Record<string, Promise<Neighborhood[]> | undefined> = {};

/** Subscribers notified after polygon data lands for a city. The
 *  IncidentMap subscribes to trigger a re-render of its district
 *  layer once polygons are available. */
const _loadListeners = new Set<(slug: string) => void>();

export function onCityNeighborhoodsLoaded(
  cb: (slug: string) => void
): () => void {
  _loadListeners.add(cb);
  return () => {
    _loadListeners.delete(cb);
  };
}

function _emitLoaded(slug: string) {
  for (const cb of _loadListeners) {
    try {
      cb(slug);
    } catch {
      /* listener error shouldn't break the load pipeline */
    }
  }
}

/** Fetch the per-city neighborhood JSON and merge into the registry.
 *  Idempotent and concurrent-safe: repeat calls during the first
 *  fetch share the same promise; subsequent calls after success are
 *  no-ops. Cities without a shipped JSON file resolve immediately to
 *  whatever is already in the registry (typically `[]`).
 *
 *  Returns the loaded `Neighborhood[]` for callers that want to
 *  await the data before using it. Most callers can fire-and-forget
 *  and rely on `onCityNeighborhoodsLoaded` to re-render. */
export function loadCityNeighborhoods(slug: string): Promise<Neighborhood[]> {
  if (typeof window === "undefined") {
    return Promise.resolve(CITY_NEIGHBORHOODS[slug] || []);
  }
  // Already populated → done.
  if ((CITY_NEIGHBORHOODS[slug] || []).length > 0) {
    return Promise.resolve(CITY_NEIGHBORHOODS[slug]);
  }
  if (!CITIES_WITH_LAZY_DATA.has(slug)) {
    return Promise.resolve(CITY_NEIGHBORHOODS[slug] || []);
  }
  const existing = _loadPromises[slug];
  if (existing) return existing;

  const p = fetch(`/neighborhoods/${slug}.json`, {
    // The file is static and content-hashed implicitly by name; let
    // the SW asset cache do its thing.
    cache: "force-cache",
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} loading ${slug}.json`);
      return res.json();
    })
    .then((data: Neighborhood[]) => {
      if (!Array.isArray(data)) throw new Error("expected array");
      CITY_NEIGHBORHOODS[slug] = data;
      _emitLoaded(slug);
      return data;
    })
    .catch((err) => {
      // Drop the cached promise so the next visit retries; surface
      // the error in dev so it's debuggable, but don't crash the app.
      delete _loadPromises[slug];
      if (typeof console !== "undefined") {
        // eslint-disable-next-line no-console
        console.warn(`[neighborhoods] failed to load ${slug}:`, err);
      }
      return CITY_NEIGHBORHOODS[slug] || [];
    });

  _loadPromises[slug] = p;
  return p;
}

/** Returns the neighborhood list for the *currently active* city.
 *  All public helpers below call this so they auto-scope to the
 *  user's deployment. To bypass scoping (e.g. preview maps for an
 *  admin tool), use `getNeighborhoodsForCity` explicitly. */
function activeNeighborhoods(): Neighborhood[] {
  try {
    return CITY_NEIGHBORHOODS[getCurrentCity().slug] || [];
  } catch {
    return [];
  }
}

export function getNeighborhoodsForCity(citySlug: string): Neighborhood[] {
  return CITY_NEIGHBORHOODS[citySlug] || [];
}

/** Backwards-compat export: callers that imported `NEIGHBORHOODS`
 *  used to get Philly directly. We now return the active city's list
 *  so the same import does the right thing on every deployment. The
 *  Proxy keeps the array spread/iter/length behaviour intact while
 *  recomputing on access (cheap — array is short). */
export const NEIGHBORHOODS: Neighborhood[] = new Proxy([] as Neighborhood[], {
  get(_target, prop, receiver) {
    return Reflect.get(activeNeighborhoods(), prop, receiver);
  },
  has(_target, prop) {
    return prop in activeNeighborhoods();
  },
  ownKeys() {
    return Reflect.ownKeys(activeNeighborhoods());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(activeNeighborhoods(), prop);
  },
});

/** Ray-casting point-in-polygon. Handles a single ring (no holes —
 *  multi-ring polygons treat ring[0] as the boundary, which matches
 *  GeoJSON for the common no-hole case). */
function pointInRing(lat: number, lng: number, ring: LngLatRing): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInNeighborhood(n: Neighborhood, lat: number, lng: number): boolean {
  if (n.polygon && n.polygon.length > 0) {
    // Cheap bbox prefilter: every polygon is contained in its bbox,
    // so failing the rectangle skips the per-vertex math entirely.
    if (
      lat < n.bounds.south ||
      lat > n.bounds.north ||
      lng < n.bounds.west ||
      lng > n.bounds.east
    ) {
      return false;
    }
    // OR across all outer rings so MultiPolygon neighborhoods (SF
    // Marina has 17 pieces incl. waterfront + offshore islands) are
    // treated as the union of their parts. Holes are not modelled —
    // neighborhood boundaries virtually never have them, and treating
    // a missing one as "inside" is the safer default for our scoring.
    for (const ring of n.polygon) {
      if (pointInRing(lat, lng, ring)) return true;
    }
    return false;
  }
  return (
    lat >= n.bounds.south &&
    lat <= n.bounds.north &&
    lng >= n.bounds.west &&
    lng <= n.bounds.east
  );
}

export function getNeighborhood(lat: number, lng: number): Neighborhood | null {
  for (const n of activeNeighborhoods()) {
    if (pointInNeighborhood(n, lat, lng)) return n;
  }
  return null;
}

export function getNeighborhoodBySlug(slug: string): Neighborhood | null {
  return activeNeighborhoods().find((n) => n.slug === slug) ?? null;
}

export function incidentsInNeighborhood(
  incidents: Incident[],
  slug: string
): Incident[] {
  const n = getNeighborhoodBySlug(slug);
  if (!n) return [];
  return incidents.filter(
    (i) => i.lat != null && i.lng != null && pointInNeighborhood(n, i.lat!, i.lng!)
  );
}
