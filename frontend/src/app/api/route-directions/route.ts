import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Per-mode street routing proxy.
 *
 * Primary: Valhalla public API (`valhalla1.openstreetmap.de`). Unlike the
 * OSRM demo at `router.project-osrm.org`, Valhalla actually has distinct
 * profiles loaded — `pedestrian`, `bicycle`, and `auto` return materially
 * different geometries (the OSRM demo aliases foot/bike to car, which made
 * Walk/Bike/Drive all draw the same polyline).
 *
 * Fallback: OSRM demo for driving only, then a mode-specific estimate.
 * We deliberately do not reuse the driving fallback for walking, biking,
 * wheelchair, or transit because that makes every mode show the same trip.
 */
const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";
const OSRM_BASE = "https://router.project-osrm.org/route/v1";

const VALHALLA_COSTING: Record<string, string> = {
  "foot-walking": "pedestrian",
  "cycling-regular": "bicycle",
  "driving-car": "auto",
  // No truly wheelchair-tuned costing in stock Valhalla; pedestrian with
  // sidewalk preferences is the closest free option.
  wheelchair: "pedestrian",
};

const OSRM_PROFILES: Record<string, string> = {
  "driving-car": "driving",
};

const ESTIMATED_SPEED_KMH: Record<string, number> = {
  "foot-walking": 4.8,
  wheelchair: 4.0,
  "cycling-regular": 15.5,
  "transit-train": 32,
  "transit-subway": 24,
  "driving-car": 34,
};

const DISTANCE_FACTORS: Record<string, number> = {
  "foot-walking": 1.18,
  wheelchair: 1.22,
  "cycling-regular": 1.22,
  "transit-train": 1.35,
  "transit-subway": 1.3,
  "driving-car": 1.28,
};

type Body = { waypoints?: unknown; mode?: string };

type RoutePayload = {
  geometry: [number, number][];
  distanceKm: number;
  durationMin: number;
  estimated?: boolean;
};

/**
 * Valhalla emits its `shape` field as a Google-style encoded polyline but
 * at 1e6 precision (a.k.a. polyline6). The five-decimal decoder elsewhere
 * in this codebase divides by 1e5 — using it here would place every point
 * 10× closer to the equator. Keep this decoder local.
 */
function decodePolyline6(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / 1e6, lng / 1e6]);
  }
  return points;
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function interpolateRoute(pts: [number, number][]): [number, number][] {
  const geometry: [number, number][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const start = pts[i];
    const end = pts[i + 1];
    const steps = Math.max(1, Math.ceil(haversineKm(start, end) / 1.2));
    for (let j = 0; j <= steps; j++) {
      if (geometry.length > 0 && j === 0) continue;
      const t = j / steps;
      geometry.push([
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ]);
    }
  }
  return geometry;
}

function estimateRoute(pts: [number, number][], mode: string): RoutePayload | null {
  if (pts.length < 2) return null;
  const directKm = pts.reduce(
    (sum, pt, idx) => (idx === 0 ? sum : sum + haversineKm(pts[idx - 1], pt)),
    0
  );
  if (!Number.isFinite(directKm) || directKm <= 0) return null;

  const factor = DISTANCE_FACTORS[mode] ?? 1.25;
  const distanceKm = directKm * factor;
  const speedKmh = ESTIMATED_SPEED_KMH[mode] ?? ESTIMATED_SPEED_KMH["driving-car"];
  const fixedAccessMin =
    mode === "transit-train"
      ? 12
      : mode === "transit-subway"
        ? 9
        : mode === "driving-car"
          ? 3
          : 0;

  return {
    geometry: interpolateRoute(pts),
    distanceKm,
    durationMin: Math.max(1, (distanceKm / speedKmh) * 60 + fixedAccessMin),
    estimated: true,
  };
}

function isImplausibleForMode(result: RoutePayload, mode: string): boolean {
  if (!Number.isFinite(result.durationMin) || result.durationMin <= 0) return true;
  const speedKmh = result.distanceKm / (result.durationMin / 60);
  if (!Number.isFinite(speedKmh)) return true;
  switch (mode) {
    case "foot-walking":
      return speedKmh > 9;
    case "wheelchair":
      return speedKmh > 7;
    case "cycling-regular":
      return speedKmh > 30;
    default:
      return false;
  }
}

async function tryValhalla(
  pts: [number, number][],
  mode: string,
  signal: AbortSignal
): Promise<RoutePayload | null> {
  const costing = VALHALLA_COSTING[mode] ?? "auto";
  try {
    const resp = await fetch(VALHALLA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal,
      body: JSON.stringify({
        locations: pts.map(([lat, lon]) => ({ lat, lon, type: "break" })),
        costing,
        units: "kilometers",
        directions_options: { units: "kilometers" },
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      trip?: {
        status?: number;
        legs?: Array<{ shape: string; summary: { time: number; length: number } }>;
        summary?: { time: number; length: number };
      };
    };
    const trip = data.trip;
    if (!trip || trip.status !== 0 || !Array.isArray(trip.legs) || trip.legs.length === 0) {
      return null;
    }
    const geometry: [number, number][] = [];
    for (const leg of trip.legs) {
      const segment = decodePolyline6(leg.shape ?? "");
      if (segment.length === 0) continue;
      if (geometry.length > 0) {
        const last = geometry[geometry.length - 1];
        if (
          Math.abs(last[0] - segment[0][0]) < 1e-6 &&
          Math.abs(last[1] - segment[0][1]) < 1e-6
        ) {
          segment.shift();
        }
      }
      geometry.push(...segment);
    }
    if (geometry.length < 2) return null;
    const distanceKm =
      trip.summary?.length ?? trip.legs.reduce((s, l) => s + (l.summary?.length ?? 0), 0);
    const durationSec =
      trip.summary?.time ?? trip.legs.reduce((s, l) => s + (l.summary?.time ?? 0), 0);
    return { geometry, distanceKm, durationMin: durationSec / 60 };
  } catch {
    return null;
  }
}

async function tryOsrm(
  pts: [number, number][],
  mode: string,
  signal: AbortSignal
): Promise<RoutePayload | null> {
  const profile = OSRM_PROFILES[mode] ?? "driving";
  const coordStr = pts.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url = `${OSRM_BASE}/${profile}/${coordStr}?overview=full&geometries=geojson`;
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "PHLPulse/1.0 (https://github.com/EYoung21/PhillyPulse)",
      },
      cache: "no-store",
      signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      code?: string;
      routes?: Array<{
        distance: number;
        duration: number;
        geometry?: { coordinates?: [number, number][] };
      }>;
    };
    if (data.code != null && data.code !== "Ok") return null;
    const route = data.routes?.[0];
    const coords = route?.geometry?.coordinates ?? [];
    if (coords.length < 2) return null;
    const geometry: [number, number][] = coords.map(([lng, lat]) => [lat, lng]);
    return {
      geometry,
      distanceKm: (route?.distance ?? 0) / 1000,
      durationMin: (route?.duration ?? 0) / 60,
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { waypoints, mode = "driving-car" } = body;
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return NextResponse.json(
      { error: "Need at least two waypoints" },
      { status: 400 }
    );
  }

  for (const w of waypoints) {
    if (
      !Array.isArray(w) ||
      w.length !== 2 ||
      typeof w[0] !== "number" ||
      typeof w[1] !== "number"
    ) {
      return NextResponse.json({ error: "Invalid waypoint" }, { status: 400 });
    }
  }

  const pts = waypoints as [number, number][];

  // Per-request abort so we never wedge a Vercel function on a slow upstream.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const valhalla =
      mode === "transit-train" || mode === "transit-subway"
        ? null
        : await tryValhalla(pts, mode, controller.signal);
    const usableValhalla =
      valhalla && !isImplausibleForMode(valhalla, mode) ? valhalla : null;
    const result =
      usableValhalla ||
      (mode === "driving-car" ? await tryOsrm(pts, mode, controller.signal) : null) ||
      estimateRoute(pts, mode);
    if (!result) {
      return NextResponse.json({ error: "No route found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } finally {
    clearTimeout(timeout);
  }
}
