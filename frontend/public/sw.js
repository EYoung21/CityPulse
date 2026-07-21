/* PhillyPulse service worker — minimal, safety-conscious cache strategy.
 *
 * Manual PWA smoke checklist (run on real devices after SW changes):
 *  - Production build only (`npm run build && npm start`) — SW is skipped in dev.
 *  - Android Chrome: install prompt / installed app opens same origin; offline tiles.
 *  - iOS Safari: Add to Home Screen → standalone; push after install (16.4+).
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

const CACHE_VERSION = "pp-v6";
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const TILE_CACHE    = `${CACHE_VERSION}-tiles`;
const ASSET_CACHE   = `${CACHE_VERSION}-assets`;

/* Hard ceiling on the tile cache. Each tile is ~5–25 KB (PNG). At 4000
 * we're capped at ~50 MB even with the largest tiles, which is well
 * within mobile-Safari's quotas while being plenty for offline use of
 * a city-sized area at multiple zoom levels. */
const MAX_TILE_ENTRIES = 4000;
const MAX_ASSET_ENTRIES = 500;

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
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll is atomic: one missing optional icon would otherwise discard the
    // successfully fetched root shell too. Cache each entry independently.
    await Promise.allSettled(SHELL_URLS.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => !k.startsWith(CACHE_VERSION))
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function isTileRequest(url) {
  const host = url.hostname.toLowerCase();
  return host === "tile.openstreetmap.org" || host.endsWith(".basemaps.cartocdn.com");
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

async function trimAssetCache(cache) {
  try {
    const keys = await cache.keys();
    const overflow = keys.length - MAX_ASSET_ENTRIES;
    if (overflow > 0) {
      await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
    }
  } catch {
    /* quota enforcement is best-effort */
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }

  // Legacy cross-city auth links placed a Firebase credential in the query
  // string. Never let those navigation URLs enter Cache Storage; the page
  // removes the parameter immediately, but the service worker sees the request
  // first. Fragment-based handoffs do not reach this code.
  if (url.searchParams.has("__pulse_token")) return;

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
            try {
              await cache.put(req, fresh.clone());
              await trimTileCache(cache);
            } catch { /* quota/cache failure must not hide the network tile */ }
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
          .then(async (r) => {
            if (r.ok) {
              try {
                await cache.put(req, r.clone());
                await trimAssetCache(cache);
              } catch { /* return the network asset even if caching fails */ }
            }
            return r;
          })
          .catch(() => cached || Response.error());
        if (cached) event.waitUntil(fresh.then(() => undefined));
        return cached || fresh;
      })
    );
    return;
  }

  // App shell (HTML / JS / CSS): network-first.
  event.respondWith((async () => {
    try {
      const r = await fetch(req);
        if (
          r.ok &&
          !url.search &&
          url.origin === self.location.origin &&
          (req.destination === "document" || req.destination === "")
        ) {
          try {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(req, r.clone());
          } catch { /* online response remains usable */ }
        }
        return r;
    } catch {
      return (await caches.match(req)) || (await caches.match("/")) || Response.error();
    }
  })());
});

/* Page-driven tile management. Replies on the same MessageChannel port
 * the page provides so callers can `await` the response. */
self.addEventListener("message", (event) => {
  event.waitUntil(handleMessage(event));
});

async function handleMessage(event) {
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
    const queue = data.urls.slice(0, MAX_TILE_ENTRIES);
    const concurrency = Math.min(12, queue.length);
    failCount += Math.max(0, data.urls.length - MAX_TILE_ENTRIES);
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (queue.length > 0) {
          const u = queue.shift();
          if (!u) break;
          try {
            const tileUrl = new URL(u, self.location.origin);
            if (!isTileRequest(tileUrl)) { failCount++; continue; }
            const existing = await cache.match(tileUrl.href);
            if (existing) { alreadyCached++; continue; }
            const r = await fetch(tileUrl.href, {
              mode: "cors",
              cache: "no-cache",
              signal: AbortSignal.timeout(15_000),
            });
            if (r.ok) {
              await cache.put(tileUrl.href, r.clone());
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
}

/* ── Web Push (VAPID) ─────────────────────────────────────────────
 *
 * We accept a JSON payload with at minimum {title, body}. Anything
 * else is optional. `url` controls where a click takes the user;
 * `tag` collapses repeated notifications with the same key so we
 * don't stack five "still happening?" pings while the phone was
 * locked.
 *
 * Defensive parsing: a malformed payload should still surface
 * *something* (a generic "PhillyPulse" title) instead of dropping
 * silently — getting nothing on a confirmed-delivered push is
 * harder to debug than getting a vague title. */
self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try { payload = event.data.json(); }
    catch {
      try { payload = { title: "PhillyPulse", body: event.data.text() }; }
      catch { payload = {}; }
    }
  }
  const title = String(payload.title || "PhillyPulse alert").slice(0, 120);
  const body  = String(payload.body  || "").slice(0, 500);
  const tag   = payload.tag ? String(payload.tag).slice(0, 120) : undefined;
  const url   = typeof payload.url === "string" ? payload.url : "/";
  // `requireInteraction` keeps high-severity alerts on screen until
  // the user dismisses them. We default to false (auto-dismiss) and
  // let the sender opt in for serious ones.
  const requireInteraction = payload.requireInteraction === true;

  const opts = {
    body,
    tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    requireInteraction,
    /* Stash the click target on the notification itself so the
       click handler doesn't need to re-parse the payload. */
    data: { url },
  };

  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  let absolute = self.location.origin + "/";
  try {
    const candidate = new URL(target, self.location.origin);
    // Push payloads are server-generated, but a notification must never become
    // an open redirect if that pipeline is misconfigured or compromised.
    if (candidate.origin === self.location.origin) absolute = candidate.href;
  } catch { /* malformed click target falls back to the app root */ }

  /* Reuse an existing PhillyPulse tab if there is one (so a click
     doesn't spawn a fresh tab on top of the user's current map
     state). Falls back to opening a new window if none of the
     existing clients live on our origin. */
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({
      type: "window", includeUncontrolled: true,
    });
    for (const c of all) {
      try {
        const u = new URL(c.url);
        if (u.origin === self.location.origin) {
          await c.focus();
          // Navigate the focused tab to the deep-link only if it
          // isn't already pointed at it — avoids needless reloads.
          if (c.url !== absolute && "navigate" in c) {
            try { await c.navigate(absolute); } catch { /* navigate not allowed */ }
          }
          return;
        }
      } catch { /* malformed client url — skip */ }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(absolute);
    }
  })());
});

/* If the browser invalidates a subscription (key rotation, user
 * cleared site data, etc.) it fires `pushsubscriptionchange`. We
 * don't have credentials to re-subscribe in the SW, so we just
 * forward a hint to any open clients; the page-side code re-runs
 * the subscribe flow, which is auth-aware. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      try { c.postMessage({ type: "PUSH_SUBSCRIPTION_CHANGED" }); } catch { /* dead client */ }
    }
  })());
});
