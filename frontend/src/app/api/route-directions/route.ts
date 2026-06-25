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
 * Fallback: mode-specific OpenStreetMap routing services, OSRM demo for
 * driving, then a mode-specific estimate. We deliberately avoid reusing
 * the driving route for walking/biking/wheelchair because that makes
 * every mode show the same trip.
 */
const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";
const OSRM_BASE = "https://router.project-osrm.org/route/v1";
const OSM_ROUTING_BASE = "https://routing.openstreetmap.de";
const OTP_URL = process.env.TRANSIT_OTP_URL || "";

// TomTom is the ONLY provider here with live traffic. When a key is present we
// use it as the primary *driving* provider so the drive ETA reflects current
// congestion (Valhalla/OSRM are free-flow only) and the geometry routes around
// jams. Walk/bike/transit stay on the free providers — traffic is irrelevant
// there. Keyless deployments fall straight through to Valhalla as before.
const TOMTOM_KEY = process.env.TOMTOM_API_KEY || "";
const TOMTOM_ROUTING = "https://api.tomtom.com/routing/1/calculateRoute";

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

const OSM_ROUTING_PROFILES: Record<string, { service: string; profile: string }> = {
  "foot-walking": { service: "routed-foot", profile: "foot" },
  wheelchair: { service: "routed-foot", profile: "foot" },
  "cycling-regular": { service: "routed-bike", profile: "bike" },
  "driving-car": { service: "routed-car", profile: "car" },
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

type TransitStation = {
  lat: number;
  lng: number;
  kind: "rail" | "subway";
};

const PHILLY_TRANSIT_STATIONS: TransitStation[] = [
  { lat: 39.9015, lng: -75.35, kind: "rail" },
  { lat: 39.9117, lng: -75.3287, kind: "rail" },
  { lat: 39.9156, lng: -75.3088, kind: "rail" },
  { lat: 39.9234, lng: -75.2962, kind: "rail" },
  { lat: 39.9376, lng: -75.2718, kind: "rail" },
  { lat: 39.9457, lng: -75.2389, kind: "rail" },
  { lat: 39.9558, lng: -75.1819, kind: "rail" },
  { lat: 39.9544, lng: -75.1683, kind: "rail" },
  { lat: 39.9528, lng: -75.1582, kind: "rail" },
  { lat: 39.9697, lng: -75.2588, kind: "subway" },
  { lat: 39.9558, lng: -75.1819, kind: "subway" },
  { lat: 39.9531, lng: -75.1656, kind: "subway" },
  { lat: 39.953, lng: -75.1635, kind: "subway" },
  { lat: 39.9476, lng: -75.1655, kind: "subway" },
  { lat: 39.9061, lng: -75.1714, kind: "subway" },
];

type Body = {
  waypoints?: unknown;
  mode?: string;
  routePref?: string;
  /** Candidate crash points [lat,lng] from CityPulse scanners. The driver
   *  only re-routes around the ones that actually fall on the fastest route
   *  (two-pass), so off-route crashes never cause a detour. */
  crashAvoid?: unknown;
};

/** A congested stretch of the route, as index range into `geometry`, for the
 *  client to draw Google-style amber/orange/red segments. */
type CongestionSpan = {
  fromIdx: number;
  toIdx: number;
  level: "moderate" | "heavy" | "severe";
};

type LaneGuidance = {
  directions: string[];
  recommended: boolean;
};

type RouteGuidanceStep = {
  instruction: string;
  distance: number;
  duration: number;
  type: number;
  way_points: [number, number];
  name?: string;
  maneuver?: string;
  signpostText?: string;
  exitNumber?: string;
  roadNumbers?: string[];
  lanes?: LaneGuidance[];
};

type RoutePayload = {
  geometry: [number, number][];
  distanceKm: number;
  durationMin: number;
  estimated?: boolean;
  /** Live-traffic extras (TomTom only; absent on free-flow providers). */
  durationNoTrafficMin?: number;
  trafficDelayMin?: number;
  trafficSource?: "tomtom";
  congestion?: CongestionSpan[];
  /** Count of fresh CityPulse crashes this route was re-routed around. */
  avoidedCrashes?: number;
  steps?: RouteGuidanceStep[];
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

function decodePolyline5(encoded: string): [number, number][] {
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
    points.push([lat / 1e5, lng / 1e5]);
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

function nearestTransitStation(
  point: [number, number],
  mode: string
): [number, number] | null {
  const wantedKind = mode === "transit-subway" ? "subway" : "rail";
  const maxKm = mode === "transit-subway" ? 18 : 10;
  let best: { point: [number, number]; km: number } | null = null;
  for (const station of PHILLY_TRANSIT_STATIONS) {
    if (station.kind !== wantedKind) continue;
    const stationPoint: [number, number] = [station.lat, station.lng];
    const km = haversineKm(point, stationPoint);
    if (km > maxKm) continue;
    if (!best || km < best.km) best = { point: stationPoint, km };
  }
  return best?.point ?? null;
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

async function withProviderTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function mergeRouteLegs(legs: [number, number][][]): [number, number][] {
  const geometry: [number, number][] = [];
  for (const leg of legs) {
    if (leg.length === 0) continue;
    if (geometry.length === 0) {
      geometry.push(...leg);
      continue;
    }
    const last = geometry[geometry.length - 1];
    const first = leg[0];
    const start =
      Math.abs(last[0] - first[0]) < 1e-6 && Math.abs(last[1] - first[1]) < 1e-6
        ? 1
        : 0;
    geometry.push(...leg.slice(start));
  }
  return geometry;
}

/** TomTom `magnitudeOfDelay` (0 unknown · 1 minor · 2 moderate · 3 major ·
 *  4 indefinite/closure) → our 3-level coloring. 0 is dropped (don't paint
 *  "unknown" as congestion). */
function magnitudeToLevel(m: number): CongestionSpan["level"] | null {
  if (m >= 4) return "severe";
  if (m === 3) return "heavy";
  if (m >= 1) return "moderate";
  return null;
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tomTomManeuverCode(instructionType?: string, message?: string): number {
  const text = `${instructionType ?? ""} ${message ?? ""}`.toLowerCase();
  if (text.includes("arriv")) return 10;
  if (text.includes("depart")) return 11;
  if (text.includes("u-turn") || text.includes("uturn")) return 9;
  if (text.includes("roundabout")) return 7;
  if (text.includes("sharp") && text.includes("left")) return 2;
  if (text.includes("sharp") && text.includes("right")) return 3;
  if ((text.includes("slight") || text.includes("bear")) && text.includes("left")) return 4;
  if ((text.includes("slight") || text.includes("bear")) && text.includes("right")) return 5;
  if (text.includes("keep") && text.includes("left")) return 12;
  if (text.includes("keep") && text.includes("right")) return 13;
  if (text.includes("left")) return 0;
  if (text.includes("right")) return 1;
  return 6;
}

function cumulativeMeters(geometry: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < geometry.length; i++) {
    out.push(out[i - 1] + haversineMeters(geometry[i - 1][0], geometry[i - 1][1], geometry[i][0], geometry[i][1]));
  }
  return out;
}

function indexForOffset(offsetM: number | undefined, cumulative: number[]): number | null {
  if (!Number.isFinite(offsetM) || cumulative.length === 0) return null;
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < cumulative.length; i++) {
    const delta = Math.abs(cumulative[i] - offsetM!);
    if (delta < bestDelta) {
      best = i;
      bestDelta = delta;
    }
  }
  return best;
}

function nearestGeometryIndex(
  point: { latitude?: number; longitude?: number } | undefined,
  geometry: [number, number][]
): number | null {
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return null;
  let best = 0;
  let bestMeters = Infinity;
  for (let i = 0; i < geometry.length; i++) {
    const d = haversineMeters(point.latitude!, point.longitude!, geometry[i][0], geometry[i][1]);
    if (d < bestMeters) {
      best = i;
      bestMeters = d;
    }
  }
  return best;
}

function laneDirections(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : typeof v === "object" && v ? clean((v as Record<string, unknown>).direction) : undefined))
      .filter((x): x is string => !!x);
  }
  const single = clean(value);
  return single ? [single] : [];
}

function normalizeLane(lane: unknown): LaneGuidance | null {
  if (!lane || typeof lane !== "object") return null;
  const record = lane as Record<string, unknown>;
  const directions = [
    ...laneDirections(record.directions),
    ...laneDirections(record.indications),
    ...laneDirections(record.arrows),
    ...laneDirections(record.direction),
  ];
  if (directions.length === 0) return null;
  return {
    directions,
    recommended:
      record.recommended === true ||
      record.follow === true ||
      record.active === true ||
      record.valid === true,
  };
}

function extractLanes(section: NonNullable<TomTomRoute["sections"]>[number]): LaneGuidance[] | null {
  const record = section as Record<string, unknown>;
  const candidate =
    (Array.isArray(record.lanes) && record.lanes) ||
    (Array.isArray(record.laneDirections) && record.laneDirections) ||
    (Array.isArray(record.laneInfo) && record.laneInfo) ||
    (Array.isArray(record.laneGuidance) && record.laneGuidance);
  if (!candidate) return null;
  const lanes = candidate
    .map(normalizeLane)
    .filter((lane): lane is LaneGuidance => !!lane);
  return lanes.length > 0 ? lanes : null;
}

function buildTomTomSteps(route: TomTomRoute, geometry: [number, number][]): RouteGuidanceStep[] | undefined {
  const instructions = route.guidance?.instructions ?? [];
  if (instructions.length === 0 || geometry.length < 2) return undefined;
  const cumulative = cumulativeMeters(geometry);
  const totalM = cumulative[cumulative.length - 1] ?? 0;

  const drafts = instructions
    .map((instruction) => {
      const pointIdx =
        Number.isFinite(instruction.pointIndex)
          ? Math.min(geometry.length - 1, Math.max(0, Number(instruction.pointIndex)))
          : nearestGeometryIndex(instruction.point, geometry) ??
            indexForOffset(instruction.routeOffsetInMeters, cumulative) ??
            0;
      const offsetM = Number.isFinite(instruction.routeOffsetInMeters)
        ? Number(instruction.routeOffsetInMeters)
        : cumulative[pointIdx] ?? 0;
      const timeS = Number.isFinite(instruction.travelTimeInSeconds)
        ? Number(instruction.travelTimeInSeconds)
        : 0;
      return {
        instruction,
        pointIdx,
        offsetM,
        timeS,
      };
    })
    .sort((a, b) => a.pointIdx - b.pointIdx || a.offsetM - b.offsetM);

  const steps = drafts.map((draft, idx): RouteGuidanceStep => {
    const next = drafts[idx + 1];
    const startIdx = draft.pointIdx;
    const endIdx = Math.max(startIdx, next?.pointIdx ?? geometry.length - 1);
    const message =
      clean(draft.instruction.message) ??
      clean(draft.instruction.instructionType) ??
      "Continue";
    const roadNumbers = Array.isArray(draft.instruction.roadNumbers)
      ? draft.instruction.roadNumbers.map(clean).filter((x): x is string => !!x)
      : undefined;
    return {
      instruction: message,
      distance: Math.max(0, (next?.offsetM ?? totalM) - draft.offsetM),
      duration: Math.max(0, (next?.timeS ?? draft.timeS) - draft.timeS),
      type: tomTomManeuverCode(draft.instruction.instructionType, message),
      way_points: [startIdx, endIdx],
      name: clean(draft.instruction.street),
      maneuver: clean(draft.instruction.instructionType) ?? clean(draft.instruction.maneuver),
      signpostText: clean(draft.instruction.signpostText),
      exitNumber: clean(draft.instruction.exitNumber),
      roadNumbers,
    };
  });

  for (const section of route.sections ?? []) {
    const sectionType = String(section.sectionType ?? "").toUpperCase();
    if (sectionType !== "LANES") continue;
    const lanes = extractLanes(section);
    if (!lanes) continue;
    const start = section.startPointIndex ?? 0;
    const target = steps.find((step) => start >= step.way_points[0] && start <= step.way_points[1]) ?? steps.find((step) => step.way_points[1] >= start);
    if (target) target.lanes = lanes;
  }

  return steps.length > 0 ? steps : undefined;
}

type TomTomRoute = {
  summary?: {
    lengthInMeters?: number;
    travelTimeInSeconds?: number;
    trafficDelayInSeconds?: number;
    noTrafficTravelTimeInSeconds?: number;
  };
  legs?: Array<{ points?: Array<{ latitude: number; longitude: number }> }>;
  guidance?: {
    instructions?: Array<{
      routeOffsetInMeters?: number;
      travelTimeInSeconds?: number;
      pointIndex?: number;
      point?: { latitude?: number; longitude?: number };
      instructionType?: string;
      maneuver?: string;
      message?: string;
      street?: string;
      signpostText?: string;
      exitNumber?: string;
      roadNumbers?: string[];
    }>;
  };
  sections?: Array<{
    sectionType?: string;
    startPointIndex?: number;
    endPointIndex?: number;
    magnitudeOfDelay?: number;
    lanes?: unknown;
    laneDirections?: unknown;
    laneGuidance?: unknown;
    laneInfo?: unknown;
  }>;
};

/**
 * Live-traffic driving routes via TomTom. `traffic=true` returns
 * congestion-adjusted travel times AND geometry that avoids active jams, so
 * the default route already "keeps moving" the way Google's does. When
 * `avoidTraffic` is set we additionally request alternatives and pick the one
 * that spends the LEAST time stuck in traffic (delay), even if its total trip
 * is a bit longer — the "I'd rather drive farther than sit" preference.
 *
 * Returns null (→ fall through to Valhalla/OSRM) when the key is missing or
 * TomTom errors, so routing degrades gracefully to free-flow estimates.
 */
function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest-vertex distance (m) from a point to a polyline. TomTom geometry is
 *  dense enough that vertex distance ≈ true perpendicular distance at our
 *  ~60 m on-route threshold. */
function minDistToPathMeters(pt: [number, number], path: [number, number][]): number {
  let min = Infinity;
  for (const [lat, lng] of path) {
    const d = haversineMeters(pt[0], pt[1], lat, lng);
    if (d < min) min = d;
  }
  return min;
}

// A fresh crash within this distance of the computed route counts as "on it".
const CRASH_ON_ROUTE_M = 60;
// Half-size of the box we tell TomTom to avoid (~110 m) — big enough to make it
// leave the blocked road, small enough not to wall off parallel streets.
const CRASH_BOX_DEG = 0.001;

type TomTomRect = {
  southWestCorner: { latitude: number; longitude: number };
  northEastCorner: { latitude: number; longitude: number };
};

async function tryTomTom(
  pts: [number, number][],
  avoidTraffic: boolean,
  crashAvoid: [number, number][],
  signal: AbortSignal
): Promise<RoutePayload | null> {
  if (!TOMTOM_KEY || pts.length < 2) return null;
  const loc = pts.map(([lat, lng]) => `${lat},${lng}`).join(":");
  const params = new URLSearchParams({
    key: TOMTOM_KEY,
    traffic: "true",
    travelMode: "car",
    routeType: "fastest",
    computeTravelTimeFor: "all",
    instructionsType: "tagged",
    routeRepresentation: "polyline",
  });
  params.append("sectionType", "traffic");
  params.append("sectionType", "lanes");
  // Alternatives only help when we're choosing the lowest-delay route.
  if (avoidTraffic) params.set("maxAlternatives", "2");
  const url = `${TOMTOM_ROUTING}/${encodeURIComponent(loc)}/json?${params}`;

  // One fetch + pick-the-chosen-route + parse. `avoidRects` switches it to a
  // POST so TomTom routes around the given boxes.
  const run = async (avoidRects?: TomTomRect[]): Promise<{ geometry: [number, number][]; payload: RoutePayload } | null> => {
    const init: RequestInit = { cache: "no-store", signal };
    if (avoidRects && avoidRects.length > 0) {
      init.method = "POST";
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify({ avoidAreas: { rectangles: avoidRects } });
    }
    const resp = await fetch(url, init);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { routes?: TomTomRoute[] };
    const routes = data.routes ?? [];
    if (routes.length === 0) return null;

    let chosen = routes[0];
    if (avoidTraffic && routes.length > 1) {
      chosen = [...routes].sort((a, b) => {
        const da = a.summary?.trafficDelayInSeconds ?? 0;
        const db = b.summary?.trafficDelayInSeconds ?? 0;
        if (da !== db) return da - db;
        return (a.summary?.travelTimeInSeconds ?? 0) - (b.summary?.travelTimeInSeconds ?? 0);
      })[0];
    }

    const geometry: [number, number][] = [];
    for (const leg of chosen.legs ?? []) {
      for (const p of leg.points ?? []) geometry.push([p.latitude, p.longitude]);
    }
    if (geometry.length < 2) return null;

    const s = chosen.summary ?? {};
    const steps = buildTomTomSteps(chosen, geometry);
    const congestion: CongestionSpan[] = [];
    for (const sec of chosen.sections ?? []) {
      if (String(sec.sectionType ?? "").toUpperCase() !== "TRAFFIC") continue;
      const level = magnitudeToLevel(sec.magnitudeOfDelay ?? 0);
      const fromIdx = sec.startPointIndex ?? 0;
      const toIdx = sec.endPointIndex ?? 0;
      if (level && toIdx > fromIdx && toIdx < geometry.length) {
        congestion.push({ fromIdx, toIdx, level });
      }
    }

    return {
      geometry,
      payload: {
        geometry,
        distanceKm: (s.lengthInMeters ?? 0) / 1000,
        durationMin: (s.travelTimeInSeconds ?? 0) / 60,
        durationNoTrafficMin: s.noTrafficTravelTimeInSeconds != null
          ? s.noTrafficTravelTimeInSeconds / 60
          : undefined,
        trafficDelayMin: (s.trafficDelayInSeconds ?? 0) / 60,
        trafficSource: "tomtom",
        congestion: congestion.length ? congestion : undefined,
        steps,
      },
    };
  };

  try {
    const first = await run();
    if (!first) return null;

    // Two-pass crash avoidance: only re-route around fresh CityPulse crashes
    // that actually sit ON the fastest route — off-route crashes are ignored,
    // so we never invent a detour. This is the scanner's head start over
    // TomTom's flow sensors put to use.
    if (crashAvoid.length > 0) {
      const onRoute = crashAvoid
        .filter((c) => minDistToPathMeters(c, first.geometry) <= CRASH_ON_ROUTE_M)
        .slice(0, 10); // TomTom caps avoidAreas at 10 rectangles
      if (onRoute.length > 0) {
        const rects: TomTomRect[] = onRoute.map(([lat, lng]) => ({
          southWestCorner: { latitude: lat - CRASH_BOX_DEG, longitude: lng - CRASH_BOX_DEG },
          northEastCorner: { latitude: lat + CRASH_BOX_DEG, longitude: lng + CRASH_BOX_DEG },
        }));
        const rerouted = await run(rects);
        if (rerouted) {
          return { ...rerouted.payload, avoidedCrashes: onRoute.length };
        }
      }
    }
    return first.payload;
  } catch {
    return null;
  }
}

async function tryValhalla(
  pts: [number, number][],
  mode: string,
  signal: AbortSignal
): Promise<RoutePayload | null> {
  const costing = VALHALLA_COSTING[mode] ?? "auto";
  // Accessibility-tuned pedestrian costing for the Wheelchair mode: a slower
  // pace, a heavy penalty on steps, flat-route preference, and a sidewalk
  // bias. This makes Wheelchair return a genuinely different time/geometry
  // than plain Walk (stock Valhalla has no dedicated wheelchair profile).
  const costingOptions =
    mode === "wheelchair"
      ? {
          pedestrian: {
            walking_speed: 3.6,
            step_penalty: 600,
            use_hills: 0.1,
            sidewalk_factor: 1.3,
            max_hiking_difficulty: 0,
          },
        }
      : undefined;
  try {
    const resp = await fetch(VALHALLA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal,
      body: JSON.stringify({
        locations: pts.map(([lat, lon]) => ({ lat, lon, type: "break" })),
        costing,
        ...(costingOptions ? { costing_options: costingOptions } : {}),
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

async function tryOsrmService(
  pts: [number, number][],
  baseUrl: string,
  profile: string,
  signal: AbortSignal
): Promise<RoutePayload | null> {
  const coordStr = pts.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url = `${baseUrl}/${profile}/${coordStr}?overview=full&geometries=geojson`;
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

async function tryOsrm(
  pts: [number, number][],
  mode: string,
  signal: AbortSignal
): Promise<RoutePayload | null> {
  const profile = OSRM_PROFILES[mode] ?? "driving";
  return tryOsrmService(pts, OSRM_BASE, profile, signal);
}

async function tryOsmRouting(
  pts: [number, number][],
  mode: string,
  signal: AbortSignal
): Promise<RoutePayload | null> {
  const cfg = OSM_ROUTING_PROFILES[mode];
  if (!cfg) return null;
  return tryOsrmService(
    pts,
    `${OSM_ROUTING_BASE}/${cfg.service}/route/v1`,
    cfg.profile,
    signal
  );
}

async function tryOsmRoutingChained(
  pts: [number, number][],
  mode: string
): Promise<RoutePayload | null> {
  if (pts.length < 2) return null;
  const legs: [number, number][][] = [];
  let distanceKm = 0;
  let durationMin = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const leg = await withProviderTimeout(5000, (signal) =>
      tryOsmRouting([pts[i], pts[i + 1]], mode, signal)
    );
    if (!leg) return null;
    legs.push(leg.geometry);
    distanceKm += leg.distanceKm;
    durationMin += leg.durationMin;
  }
  const geometry = mergeRouteLegs(legs);
  if (geometry.length < 2) return null;
  return { geometry, distanceKm, durationMin };
}

async function tryOtpTransit(
  pts: [number, number][],
  mode: string,
  signal: AbortSignal
): Promise<RoutePayload | null> {
  if (!OTP_URL || pts.length !== 2) return null;
  const otpMode = mode === "transit-subway" ? "SUBWAY" : "RAIL";
  const now = new Date().toISOString();
  const params = new URLSearchParams({
    fromPlace: `${pts[0][0]},${pts[0][1]}`,
    toPlace: `${pts[1][0]},${pts[1][1]}`,
    date: now.slice(0, 10),
    time: now.slice(11, 16),
    mode: `WALK,${otpMode}`,
    numItineraries: "1",
    maxWalkDistance: "1500",
    arriveBy: "false",
  });
  try {
    const resp = await fetch(`${OTP_URL}/otp/routers/default/plan?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CityPulse/1.0",
      },
      cache: "no-store",
      signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      plan?: {
        itineraries?: Array<{
          duration: number;
          legs: Array<{
            distance?: number;
            from: { lat: number; lon: number };
            to: { lat: number; lon: number };
            legGeometry?: { points?: string };
          }>;
        }>;
      };
    };
    const itinerary = data.plan?.itineraries?.[0];
    if (!itinerary?.legs?.length) return null;
    const legs: [number, number][][] = [];
    let distanceKm = 0;
    for (const leg of itinerary.legs) {
      distanceKm += (leg.distance ?? 0) / 1000;
      const decoded = leg.legGeometry?.points ? decodePolyline5(leg.legGeometry.points) : [];
      legs.push(
        decoded.length >= 2
          ? decoded
          : [
              [leg.from.lat, leg.from.lon],
              [leg.to.lat, leg.to.lon],
            ]
      );
    }
    const geometry = mergeRouteLegs(legs);
    if (geometry.length < 2) return null;
    return {
      geometry,
      distanceKm,
      durationMin: itinerary.duration / 60,
    };
  } catch {
    return null;
  }
}

async function tryTransitFallback(
  pts: [number, number][],
  mode: string
): Promise<RoutePayload | null> {
  const estimate = estimateRoute(pts, mode);
  if (!estimate) return null;

  if (pts.length === 2) {
    const startStation = nearestTransitStation(pts[0], mode);
    const endStation = nearestTransitStation(pts[1], mode);
    if (startStation && endStation) {
      const stationWaypoints = [pts[0], startStation, endStation, pts[1]];
      const stationRoute = await tryOsmRoutingChained(stationWaypoints, "foot-walking");
      if (stationRoute) {
        return {
          ...stationRoute,
          durationMin: estimate.durationMin,
          estimated: true,
        };
      }
    }
  }

  const routed = await tryOsmRoutingChained(pts, "foot-walking");
  return routed
    ? {
        ...routed,
        durationMin: estimate.durationMin,
        estimated: true,
      }
    : null;
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

  if (waypoints.length > 25) {
    return NextResponse.json(
      { error: "Too many waypoints (max 25)" },
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
  const isTransit = mode === "transit-train" || mode === "transit-subway";

  // Live-traffic driving via TomTom first (only when a key is configured and
  // the mode is car). Everything else — and any TomTom failure — falls through
  // to the existing free providers untouched.
  // Validate crash-avoidance candidates: array of [lat,lng], cap to 20.
  const crashAvoid: [number, number][] = Array.isArray(body.crashAvoid)
    ? (body.crashAvoid as unknown[])
        .filter(
          (c): c is [number, number] =>
            Array.isArray(c) &&
            c.length === 2 &&
            typeof c[0] === "number" &&
            typeof c[1] === "number"
        )
        .slice(0, 20)
    : [];

  const tomtom =
    mode === "driving-car" && TOMTOM_KEY
      ? await withProviderTimeout(8000, (signal) =>
          tryTomTom(pts, body.routePref === "avoid_traffic", crashAvoid, signal)
        )
      : null;

  const valhalla =
    isTransit || tomtom
      ? null
      : await withProviderTimeout(4500, (signal) => tryValhalla(pts, mode, signal));
  const usableValhalla =
    valhalla && !isImplausibleForMode(valhalla, mode) ? valhalla : null;
  const osmProfileRoute =
    !usableValhalla && !isTransit
      ? await tryOsmRoutingChained(pts, mode)
      : null;
  const drivingFallback =
    !usableValhalla && !osmProfileRoute && mode === "driving-car"
      ? await withProviderTimeout(5000, (signal) => tryOsrm(pts, mode, signal))
      : null;
  const transitRoute = isTransit
    ? (await withProviderTimeout(6000, (signal) => tryOtpTransit(pts, mode, signal))) ||
      (await tryTransitFallback(pts, mode))
    : null;
  const result =
    tomtom ||
    usableValhalla ||
    osmProfileRoute ||
    drivingFallback ||
    transitRoute ||
    estimateRoute(pts, mode);
  if (!result) {
    return NextResponse.json({ error: "No route found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
