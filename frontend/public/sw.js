/* PhillyPulse service worker — minimal, safety-conscious cache strategy.
 *
 * Strategies:
 *  - HTML / Next-built JS+CSS:    network-first, fall back to cache (so we
 *                                  never serve stale safety data when online).
 *  - Map tiles (CARTO):           cache-first with 7-day TTL via cache name.
 *  - Static images / fonts:       stale-while-revalidate.
 *  - Everything else (APIs etc.): pass-through, never cached.
 *
 * Bumping CACHE_VERSION invalidates all caches on the next activation. */

const CACHE_VERSION = "pp-v1";
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const TILE_CACHE    = `${CACHE_VERSION}-tiles`;
const ASSET_CACHE   = `${CACHE_VERSION}-assets`;

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
          if (fresh.ok) cache.put(req, fresh.clone());
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
