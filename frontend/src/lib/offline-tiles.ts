"use client";

/** Offline tile pre-caching client.
 *
 *  Talks to the service worker to pre-download map tiles for an
 *  arbitrary lat/lng bounds + zoom range, so the user can keep using
 *  the map when they lose connectivity (subway tunnels, dead zones,
 *  international travel, etc.).
 *
 *  Coverage strategy:
 *    For each zoom level z in [minZoom..maxZoom], compute the tile-grid
 *    bounding rectangle that covers the requested geographic bounds and
 *    enumerate every (z,x,y) tile inside it. Each integer-zoom tile
 *    covers a fixed 256x256-pixel area, so doubling the zoom level
 *    quadruples the tile count. We hard-cap the total request size at
 *    MAX_PRECACHE_TILES so a tap-happy user can't accidentally try to
 *    download all of Philly at z19 (millions of tiles).
 *
 *  The SW handles fetch concurrency, caching, and LRU eviction.
 */

const TILE_HOSTS = ["a", "b", "c", "d"];
const MAX_PRECACHE_TILES = 2500;

export interface PrecacheBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface PrecacheResult {
  requested: number;
  ok: number;
  fail: number;
  alreadyCached: number;
}

export interface CacheStats {
  count: number;
  max: number;
}

/** Standard slippy-map tile math. Returns the (x,y) tile a given
 *  lat/lng falls into at zoom z. Lat is clamped to the Web Mercator
 *  envelope so requests just outside the visible map don't NaN. */
function lngLatToTile(lat: number, lng: number, z: number): { x: number; y: number } {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (clampedLat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

/** Build the list of CARTO tile URLs needed to cover `bounds` at
 *  every zoom in [minZoom..maxZoom] for the given basemap template. */
export function enumerateTileUrls(
  bounds: PrecacheBounds,
  minZoom: number,
  maxZoom: number,
  template: string
): string[] {
  const urls: string[] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const tl = lngLatToTile(bounds.north, bounds.west, z);
    const br = lngLatToTile(bounds.south, bounds.east, z);
    const xMin = Math.min(tl.x, br.x);
    const xMax = Math.max(tl.x, br.x);
    const yMin = Math.min(tl.y, br.y);
    const yMax = Math.max(tl.y, br.y);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        // CARTO subdomain rotation by tile coords helps spread load
        // across the four CDN endpoints (a/b/c/d). OSM uses a single
        // host so {s} just becomes "a" — harmless.
        const sub = TILE_HOSTS[(x + y) % TILE_HOSTS.length];
        const url = template
          .replace("{s}", sub)
          .replace("{z}", String(z))
          .replace("{x}", String(x))
          .replace("{y}", String(y))
          .replace("{r}", ""); // skip retina suffix for cache keys
        urls.push(url);
        if (urls.length >= MAX_PRECACHE_TILES) return urls;
      }
    }
  }
  return urls;
}

/** Estimate (lower bound) the number of tiles a precache request will
 *  produce, so the UI can show a "this will download ~N tiles" hint
 *  before the user commits. Returns the same number as
 *  `enumerateTileUrls(...).length`. */
export function estimateTileCount(
  bounds: PrecacheBounds,
  minZoom: number,
  maxZoom: number
): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const tl = lngLatToTile(bounds.north, bounds.west, z);
    const br = lngLatToTile(bounds.south, bounds.east, z);
    const w = Math.abs(tl.x - br.x) + 1;
    const h = Math.abs(tl.y - br.y) + 1;
    total += w * h;
    if (total >= MAX_PRECACHE_TILES) return MAX_PRECACHE_TILES;
  }
  return total;
}

/** Send a typed message to the active service worker and resolve with
 *  its reply on the same MessageChannel port. Times out after 90s for
 *  the precache call (tile downloads at low bandwidth can be slow). */
function postToSW<T>(message: unknown, timeoutMs = 90_000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) {
      reject(new Error("no-active-service-worker"));
      return;
    }
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => {
      reject(new Error("sw-message-timeout"));
    }, timeoutMs);
    channel.port1.onmessage = (e) => {
      window.clearTimeout(timer);
      resolve(e.data as T);
    };
    navigator.serviceWorker.controller.postMessage(message, [channel.port2]);
  });
}

export async function precacheTiles(
  bounds: PrecacheBounds,
  minZoom: number,
  maxZoom: number,
  template: string
): Promise<PrecacheResult> {
  const urls = enumerateTileUrls(bounds, minZoom, maxZoom, template);
  if (urls.length === 0) {
    return { requested: 0, ok: 0, fail: 0, alreadyCached: 0 };
  }
  const reply = await postToSW<{ ok: number; fail: number; cached: number }>({
    type: "PRECACHE_TILES",
    urls,
  });
  return {
    requested: urls.length,
    ok: reply.ok ?? 0,
    fail: reply.fail ?? 0,
    alreadyCached: reply.cached ?? 0,
  };
}

export async function getTileCacheStats(): Promise<CacheStats | null> {
  try {
    return await postToSW<CacheStats>({ type: "TILE_CACHE_STATS" }, 5_000);
  } catch {
    return null;
  }
}

export async function clearTileCache(): Promise<boolean> {
  try {
    const r = await postToSW<{ cleared: boolean }>({ type: "CLEAR_TILE_CACHE" }, 10_000);
    return !!r.cleared;
  } catch {
    return false;
  }
}

export const TILE_PRECACHE_LIMIT = MAX_PRECACHE_TILES;
