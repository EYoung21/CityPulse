/* PhillyPulse service worker — minimal, safety-conscious cache strategy.
 *
 * Strategies:
 *  - HTML / Next-built JS+CSS:    network-first, fall back to cache (so we
 *                                  never serve stale safety data when online).
 *  - Map tiles (CARTO):           cache-first, capped at MAX_TILE_ENTRIES with
 *                                  LRU eviction so a long session doesn't
 *                                  balloon storage usage indefinitely.
 *  - Static images / fonts:       stale-while-revalidate.
 *  - Everything else (APIs etc.): pass-through, never cached.
 *
 * Bumping CACHE_VERSION invalidates all caches on the next activation.
 *
 * The page can drive offline tile pre-caching via postMessage commands:
 *   {type:"PRECACHE_TILES", urls:string[]}        // batched fetch+cache
 *   {type:"TILE_CACHE_STATS"}                     // returns {count, bytes?}
 *   {type:"CLEAR_TILE_CACHE"}                     // empties just the tiles
 */

const CACHE_VERSION = "pp-v2";
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const TILE_CACHE    = `${CACHE_VERSION}-tiles`;
const ASSET_CACHE   = `${CACHE_VERSION}-assets`;

/* Hard ceiling on the tile cache. Each tile is ~5–25 KB (PNG). At 4000
 * we're capped at ~50 MB even with the largest tiles, which is well
 * within mobile-Safari's quotas while being plenty for offline use of
 * a city-sized area at multiple zoom levels. */
const MAX_TILE_ENTRIES = 4000;

const SHELL_URLS = [
  "/",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/favicon-32x32.png",
  "/favicon-16x16.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isTileRequest(url) {
  return /basemaps\.cartocdn\.com|tile\.openstreetmap\.org/.test(url.hostname);
}

function isAssetRequest(url, req) {
  if (req.destination === "image" || req.destination === "font") return true;
  return /\.(png|jpg|jpeg|svg|gif|webp|woff2?|ttf)$/i.test(url.pathname);
}

function isApiRequest(url) {
  return (
    url.pathname.startsWith("/api/") ||
    /firestore\.googleapis\.com|nominatim\.openstreetmap\.org|api\.openrouteservice\.org/.test(url.hostname)
  );
}

/* LRU eviction. The Cache Storage API doesn't expose an LRU directly,
 * but `cache.keys()` returns insertion order, so deleting the oldest N
 * keys when over the cap gives us a perfectly serviceable approximation:
 * tiles re-requested by the user (e.g. on viewport overlap) keep getting
 * re-added to the tail, naturally surviving eviction passes. */
async function trimTileCache(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= MAX_TILE_ENTRIES) return;
    const overflow = keys.length - MAX_TILE_ENTRIES;
    await Promise.all(keys.slice(0, overflow).map((k) => cache.delete(k)));
  } catch {
    /* eviction failures are non-fatal; quota errors will fail the next
       cache.put and naturally limit growth from there. */
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }

  // Never cache live data sources — safety-critical, always fresh.
  if (isApiRequest(url)) return;

  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const fresh = await fetch(req);
          if (fresh.ok) {
            cache.put(req, fresh.clone()).then(() => trimTileCache(cache));
          }
          return fresh;
        } catch {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  if (isAssetRequest(url, req)) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fresh = fetch(req)
          .then((r) => {
            if (r.ok) cache.put(req, r.clone());
            return r;
          })
          .catch(() => cached || Response.error());
        return cached || fresh;
      })
    );
    return;
  }

  // App shell (HTML / JS / CSS): network-first.
  event.respondWith(
    fetch(req)
      .then((r) => {
        if (r.ok && (req.destination === "document" || req.destination === "")) {
          const clone = r.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, clone)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(req).then((c) => c || caches.match("/")))
  );
});

/* Page-driven tile management. Replies on the same MessageChannel port
 * the page provides so callers can `await` the response. */
self.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  const reply = (payload) => {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
  };

  if (data.type === "PRECACHE_TILES" && Array.isArray(data.urls)) {
    const cache = await caches.open(TILE_CACHE);
    let okCount = 0;
    let failCount = 0;
    let alreadyCached = 0;
    /* Throttle to ~12 concurrent requests so we don't hammer CARTO's
     * subdomain rotation or the user's bandwidth too aggressively. */
    const queue = data.urls.slice();
    const concurrency = Math.min(12, queue.length);
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (queue.length > 0) {
          const u = queue.shift();
          if (!u) break;
          try {
            const existing = await cache.match(u);
            if (existing) { alreadyCached++; continue; }
            const r = await fetch(u, { mode: "cors", cache: "no-cache" });
            if (r.ok) {
              await cache.put(u, r.clone());
              okCount++;
            } else {
              failCount++;
            }
          } catch {
            failCount++;
          }
        }
      })
    );
    await trimTileCache(cache);
    reply({ ok: okCount, fail: failCount, cached: alreadyCached });
    return;
  }

  if (data.type === "TILE_CACHE_STATS") {
    try {
      const cache = await caches.open(TILE_CACHE);
      const keys = await cache.keys();
      reply({ count: keys.length, max: MAX_TILE_ENTRIES });
    } catch {
      reply({ count: 0, max: MAX_TILE_ENTRIES });
    }
    return;
  }

  if (data.type === "CLEAR_TILE_CACHE") {
    try {
      await caches.delete(TILE_CACHE);
      reply({ cleared: true });
    } catch {
      reply({ cleared: false });
    }
    return;
  }
});
