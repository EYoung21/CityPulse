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
 * Fallback: OSRM demo. Kept so a single mode (driving) still works when
 * Valhalla is rate-limited or down. The fallback geometry will be the
 * same for every mode, but at least the route renders.
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
  // Transit modes draw the walking leg only — the OTP /api/transit-directions
  // endpoint covers the real itinerary when configured.
  "transit-train": "pedestrian",
  "transit-subway": "pedestrian",
};

const OSRM_PROFILES: Record<string, string> = {
  "foot-walking": "foot",
  "cycling-regular": "bike",
  "driving-car": "car",
};

type Body = { waypoints?: unknown; mode?: string };

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

async function tryValhalla(
  pts: [number, number][],
  mode: string,
  signal: AbortSignal
): Promise<{ geometry: [number, number][]; distanceKm: number; durationMin: number } | null> {
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
): Promise<{ geometry: [number, number][]; distanceKm: number; durationMin: number } | null> {
  const profile = OSRM_PROFILES[mode] ?? "car";
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
    const result =
      (await tryValhalla(pts, mode, controller.signal)) ||
      (await tryOsrm(pts, mode, controller.signal));
    if (!result) {
      return NextResponse.json({ error: "No route found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } finally {
    clearTimeout(timeout);
  }
}
