"use client";

import { useEffect, useRef, useState } from "react";
import { isCoordinatePair } from "@/lib/geo-validation";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

/** Looks up the OSM `maxspeed` tag for the road segment closest to the
 *  user's current location and returns it in the user's preferred unit
 *  (mph for `imperial`, km/h for `metric`). Returns null while loading
 *  or when no road within 50m has a maxspeed tag.
 *
 *  Why this is a separate hook from `useGpsSpeed`:
 *  - Speed limit changes infrequently (every block or so), GPS speed
 *    updates every second. Keeping them decoupled means the badge
 *    re-renders only when the snapped segment actually changes.
 *  - Overpass is rate-limited; we cache aggressively per ~50m cell so
 *    a stationary user only fires one network call regardless of GPS
 *    jitter, and a typical 30 mph drive fires ~1 call per minute.
 *
 *  Limitations:
 *  - We pick the *closest* highway way within 50m. Overpasses, frontage
 *    roads, and adjacent surface streets within that radius can fool
 *    the snap, so the badge falls back to "—" rather than guessing
 *    when no candidate is clearly closer.
 *  - "maxspeed" can be a number, "30 mph", "30 km/h", or implicit
 *    (`maxspeed:type=US:urban` etc). We parse the explicit numeric/unit
 *    form and ignore the implicit type — implicit limits would need a
 *    country-specific table we don't ship.
 */

const OVERPASS = "https://overpass-api.de/api/interpreter";
const CELL_SIZE_DEG = 0.0005; // ~55m at Philly's latitude
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 256;

interface CacheEntry {
  /** maxspeed in km/h, or null if no road within 50m has one. */
  limitKmh: number | null;
  ts: number;
}

const cache = new Map<string, CacheEntry>();

function cellKey(lat: number, lng: number): string {
  const la = Math.round(lat / CELL_SIZE_DEG) * CELL_SIZE_DEG;
  const ln = Math.round(lng / CELL_SIZE_DEG) * CELL_SIZE_DEG;
  return `${la.toFixed(4)},${ln.toFixed(4)}`;
}

/** Distance from point P to the great-circle segment AB, in meters.
 *  Uses an equirectangular projection — accurate within a few percent
 *  at city scale and avoids pulling in turf for one calc. */
function distToSegM(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const meanLat = ((a[0] + b[0] + p[0]) / 3) * (Math.PI / 180);
  const cosLat = Math.cos(meanLat);
  const ax = a[1] * cosLat, ay = a[0];
  const bx = b[1] * cosLat, by = b[0];
  const px = p[1] * cosLat, py = p[0];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const nx = ax + t * dx, ny = ay + t * dy;
  const ddx = (px - nx), ddy = (py - ny);
  return Math.hypot(ddx, ddy) * 111_320;
}

/** Parse OSM `maxspeed` tag values into km/h. Returns null when the
 *  tag is missing, implicit-only (e.g. "US:urban"), or unparsable. */
function parseMaxspeed(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  // Pure number → km/h by OSM convention.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    return Number.isFinite(n) && n > 0 && n < 200 ? n : null;
  }
  const mphMatch = s.match(/^(\d+(?:\.\d+)?)\s*mph$/);
  if (mphMatch) {
    const n = parseFloat(mphMatch[1]);
    return Number.isFinite(n) ? n * 1.609344 : null;
  }
  const kmhMatch = s.match(/^(\d+(?:\.\d+)?)\s*km\/?h$/);
  if (kmhMatch) {
    const n = parseFloat(kmhMatch[1]);
    return Number.isFinite(n) ? n : null;
  }
  // Skip "walk", "none", "signals", "variable", etc.
  return null;
}

interface OverpassWay {
  type: "way";
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

function normalizeOverpassWays(value: unknown): OverpassWay[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const elements = (value as Record<string, unknown>).elements;
  if (!Array.isArray(elements)) return [];
  return elements.slice(0, 200).flatMap((element): OverpassWay[] => {
    if (!element || typeof element !== "object" || Array.isArray(element)) return [];
    const row = element as Record<string, unknown>;
    if (row.type !== "way") return [];
    const tags = row.tags && typeof row.tags === "object" && !Array.isArray(row.tags)
      ? row.tags as Record<string, unknown>
      : null;
    const maxspeed = typeof tags?.maxspeed === "string" ? tags.maxspeed.slice(0, 100) : undefined;
    const geometry = Array.isArray(row.geometry)
      ? row.geometry.slice(0, 10_000).flatMap((point) => {
          if (!point || typeof point !== "object" || Array.isArray(point)) return [];
          const candidate = point as Record<string, unknown>;
          const coordinates = [candidate.lat, candidate.lon];
          return isCoordinatePair(coordinates)
            ? [{ lat: coordinates[0], lon: coordinates[1] }]
            : [];
        })
      : [];
    return [{ type: "way", tags: maxspeed ? { maxspeed } : {}, geometry }];
  });
}

async function fetchSnap(lat: number, lng: number): Promise<number | null> {
  // 50m radius — wide enough to tolerate consumer-grade GPS noise,
  // narrow enough to not pick up the next street over.
  const RADIUS = 50;
  const q = `
    [out:json][timeout:8];
    way(around:${RADIUS},${lat},${lng})
      ["highway"]
      ["maxspeed"];
    out tags geom;
  `.trim();

  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const ways = normalizeOverpassWays(await readBoundedJsonResponse(res, 4 * 1024 * 1024));
  if (ways.length === 0) return null;

  // Pick the way whose closest geometry segment is nearest the point.
  let best: { dist: number; speedKmh: number } | null = null;
  for (const w of ways) {
    const speed = parseMaxspeed(w.tags?.maxspeed);
    if (speed === null) continue;
    const geom = w.geometry;
    if (!geom || geom.length < 2) continue;
    let minDist = Infinity;
    for (let i = 1; i < geom.length; i++) {
      const a: [number, number] = [geom[i - 1].lat, geom[i - 1].lon];
      const b: [number, number] = [geom[i].lat, geom[i].lon];
      const d = distToSegM([lat, lng], a, b);
      if (d < minDist) minDist = d;
    }
    if (!best || minDist < best.dist) best = { dist: minDist, speedKmh: speed };
  }
  return best ? best.speedKmh : null;
}

export interface SpeedLimitReading {
  /** km/h. Null = no nearby maxspeed-tagged road, undefined = still loading. */
  limitKmh: number | null | undefined;
  /** True while the *first* lookup for this cell is pending. */
  loading: boolean;
}

/** Live snapped speed-limit reading for the given location. Pass null
 *  to disable polling (e.g. when GPS is off / not driving). */
export function useSpeedLimit(
  loc: { lat: number; lng: number } | null,
  enabled: boolean = true
): SpeedLimitReading {
  const [reading, setReading] = useState<SpeedLimitReading>({
    limitKmh: undefined,
    loading: false,
  });
  const lastCellRef = useRef<string | null>(null);
  const lat = loc?.lat;
  const lng = loc?.lng;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!enabled || lat == null || lng == null) {
        lastCellRef.current = null;
        if (!cancelled) setReading({ limitKmh: undefined, loading: false });
        return;
      }

      const key = cellKey(lat, lng);
      if (key === lastCellRef.current) return;
      lastCellRef.current = key;

      const cached = cache.get(key);
      const now = Date.now();
      if (cached && now - cached.ts < CACHE_TTL_MS) {
        if (!cancelled) setReading({ limitKmh: cached.limitKmh, loading: false });
        return;
      }

      if (!cancelled) {
        setReading((prev) => ({ limitKmh: prev.limitKmh, loading: true }));
      }
      try {
        const limit = await fetchSnap(lat, lng);
        cache.set(key, { limitKmh: limit, ts: Date.now() });
        if (cache.size > CACHE_MAX) {
          // Drop the oldest entry — Map preserves insertion order.
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
        if (!cancelled) setReading({ limitKmh: limit, loading: false });
      } catch {
        if (!cancelled) setReading((prev) => ({ limitKmh: prev.limitKmh, loading: false }));
      }
    })();

    return () => { cancelled = true; };
  }, [enabled, lat, lng]);

  return reading;
}

/** Convert km/h speed-limit to the user's preferred display unit. */
export function formatSpeedLimit(
  limitKmh: number | null | undefined,
  unit: "mph" | "kmh"
): string | null {
  if (limitKmh == null) return null;
  if (unit === "mph") return String(Math.round(limitKmh / 1.609344));
  return String(Math.round(limitKmh));
}
