import type { Incident } from "./api";
import { apiUrl } from "@/lib/public-api-base";

const ORS_URL = "https://api.openrouteservice.org/v2/directions";

function routeDirectionsUrl(): string {
  return apiUrl("/api/route-directions");
}

export type TransportMode =
  | "foot-walking"
  | "cycling-regular"
  | "driving-car"
  | "wheelchair"
  | "transit-train"
  | "transit-subway";

/** Map a UI transport mode to the ORS API profile name. Transit modes
 *  fall back to `foot-walking` because ORS has no public-transit profile.
 *  The UI shows a note when a transit mode is active. */
export function orsProfile(mode: TransportMode): string {
  switch (mode) {
    case "transit-train":
    case "transit-subway":
      return "foot-walking";
    default:
      return mode;
  }
}

/** Returns true when the selected mode is a transit placeholder that
 *  falls back to walking directions internally. */
export function isTransitMode(mode: TransportMode): boolean {
  return mode === "transit-train" || mode === "transit-subway";
}

export interface LaneGuidance {
  directions: string[];
  recommended: boolean;
}

/** A single turn-by-turn step. ORS returns per-segment steps with:
 *   instruction → human-readable ("Turn left onto Main St")
 *   distance    → meters until the maneuver completes
 *   duration    → seconds for that step
 *   type        → ORS maneuver code (0..13). 10 = arrive, 11 = depart, etc.
 *   way_points  → [startIdx, endIdx] into the route geometry array
 *   name        → upcoming road name (best-effort)
 *
 *  Only populated when the route comes from ORS (OSRM fallback omits it). */
export interface ManeuverStep {
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
}

/** A congested stretch of a driving route (index range into `geometry`). */
export interface CongestionSpan {
  fromIdx: number;
  toIdx: number;
  level: "moderate" | "heavy" | "severe";
}

export interface RouteResult {
  geometry: [number, number][];
  distanceKm: number;
  durationMin: number;
  isSafe: boolean;
  steps?: ManeuverStep[];
  /** True when the routing proxy had to use a mode-specific estimate
   *  because an upstream profile was unavailable. */
  estimated?: boolean;
  /** ORS-defined road features avoided when this route was computed
   *  (e.g. ["tollways", "highways"]). Empty/undefined when the call was
   *  not constrained. */
  avoidedFeatures?: string[];
  /** Live-traffic fields — present only for driving routes resolved via the
   *  TomTom provider. `durationMin` already includes traffic; these expose
   *  the free-flow baseline + how much of the ETA is congestion. */
  durationNoTrafficMin?: number;
  trafficDelayMin?: number;
  trafficSource?: "tomtom";
  congestion?: CongestionSpan[];
  /** Number of fresh CityPulse crashes this route was re-routed around. */
  avoidedCrashes?: number;
}

/** Subset of ORS `avoid_features` we expose in the UI. */
export type AvoidFeature = "tollways" | "highways" | "ferries";

/** A user-selectable route option presented before trip start. */
export interface RouteOption {
  id: string;
  /** Short label rendered on the picker card ("Fastest", "Safer", …). */
  label: string;
  /** One-liner displayed below the label. */
  subtitle?: string;
  route: RouteResult;
  /** Whether this option came from the safer-routes pipeline (avoid
   *  polygons applied). */
  isSafer: boolean;
  /** Pinned avoid-features used when computing this option. */
  avoidedFeatures: AvoidFeature[];
}

/**
 * When true, the pre-trip picker only lists incident-avoiding options
 * (`isSafer`). Fastest / no-tolls / no-highways variants are still
 * requested inside `getRouteOptions` — callers filter with
 * `filterRouteOptionsForSafestOnlyUi` before populating UI state.
 */
export const SAFEST_ROUTE_ONLY_UI = true;

export function filterRouteOptionsForSafestOnlyUi(options: RouteOption[]): RouteOption[] {
  if (!SAFEST_ROUTE_ONLY_UI) return options;
  const safer = options.filter((o) => o.isSafer);
  return safer.length > 0 ? safer : options;
}

export interface AvoidZone {
  center: [number, number];
  radiusM: number;
}

function circleToPolygon(
  lat: number,
  lng: number,
  radiusM: number,
  points = 16
): number[][] {
  const coords: number[][] = [];
  const R = 6371000;
  for (let i = 0; i <= points; i++) {
    const angle = (2 * Math.PI * i) / points;
    const dLat = (radiusM * Math.cos(angle)) / R;
    const dLng =
      (radiusM * Math.sin(angle)) / (R * Math.cos((lat * Math.PI) / 180));
    coords.push([lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI]);
  }
  return coords;
}

export const AVOIDANCE_CATEGORIES = [
  { id: "violent", label: "Violent", cats: ["violent_weapon", "violent_no_weapon", "shots_heard", "robbery", "burglary_in_progress"] },
  { id: "fire", label: "Fire", cats: ["fire_hazmat"] },
  { id: "medical", label: "Medical", cats: ["medical_priority", "medical_other"] },
  { id: "traffic", label: "Traffic", cats: ["traffic_crash_injury", "traffic_crash_no_injury"] },
  { id: "disorder", label: "Disorder", cats: ["disorder", "admin_or_noise"] },
] as const;

export type AvoidCategoryId = typeof AVOIDANCE_CATEGORIES[number]["id"];

/** Human-readable name for each raw `severity_category` value. Used by
 *  the per-leaf checkbox UI inside each avoidance bucket. */
export const LEAF_LABELS: Record<string, string> = {
  violent_weapon:          "Armed violence",
  violent_no_weapon:       "Unarmed violence",
  shots_heard:             "Shots fired",
  robbery:                 "Robbery",
  burglary_in_progress:    "Burglary in progress",
  fire_hazmat:             "Fire / hazmat",
  medical_priority:        "Medical (priority)",
  medical_other:           "Medical (other)",
  traffic_crash_injury:    "Crash with injuries",
  traffic_crash_no_injury: "Crash, no injuries",
  disorder:                "Disorder",
  admin_or_noise:          "Admin / noise",
};

/** Default leaf categories the user is opted into avoiding on first
 *  visit — equivalent to the prior bucket-level default of
 *  ["violent", "fire"]. */
export const DEFAULT_AVOID_LEAVES: ReadonlySet<string> = new Set([
  ...AVOIDANCE_CATEGORIES.find((b) => b.id === "violent")!.cats,
  ...AVOIDANCE_CATEGORIES.find((b) => b.id === "fire")!.cats,
]);

/** Severity floor applied alongside the per-leaf set — only incidents
 *  with `w_eff >= minSeverity` and a checked leaf cat make it into the
 *  avoidance zones. The four constants line up with the four pill stops
 *  rendered in the UI (Any / Low+ / Medium+ / High+). */
export const SEVERITY_FLOORS = {
  any: 0,
  low: 0.25,
  medium: 0.5,
  high: 0.75,
} as const;
export type SeverityFloor = keyof typeof SEVERITY_FLOORS;

export interface AvoidancePrefs {
  /** Raw `severity_category` values the user wants routing to avoid. */
  leaves: Set<string>;
  /** Floor on `w_eff`. Defaults to `"low"` (0.25), which matches the
   *  threshold the legacy `buildAvoidZones` baked in implicitly. */
  minSeverity: SeverityFloor;
  /** Optional time-window for routing avoidance, in hours. When set,
   *  `buildAvoidZones` drops any incident older than `Date.now() -
   *  maxAgeHours * 3600 * 1000`. Undefined = follow whatever window the
   *  caller already passed in (typically the global time filter). */
  maxAgeHours?: number;
}

export function defaultAvoidancePrefs(): AvoidancePrefs {
  return {
    leaves: new Set(DEFAULT_AVOID_LEAVES),
    minSeverity: "low",
    maxAgeHours: undefined,
  };
}

/** Backwards-compat shim: any older call site still passing the
 *  bucket-level `Set<AvoidCategoryId>` gets converted to the new shape
 *  with the legacy 0.25 floor. Prefer passing `AvoidancePrefs` directly. */
export function avoidCatsToPrefs(buckets: Set<AvoidCategoryId>): AvoidancePrefs {
  const leaves = new Set<string>();
  for (const ac of AVOIDANCE_CATEGORIES) {
    if (buckets.has(ac.id)) {
      for (const c of ac.cats) leaves.add(c);
    }
  }
  return { leaves, minSeverity: "low" };
}

export function buildAvoidZones(
  incidents: Incident[],
  prefsOrCats?: AvoidancePrefs | Set<AvoidCategoryId>
): AvoidZone[] {
  let prefs: AvoidancePrefs;
  if (!prefsOrCats) {
    prefs = defaultAvoidancePrefs();
  } else if (prefsOrCats instanceof Set) {
    prefs = avoidCatsToPrefs(prefsOrCats);
  } else {
    prefs = prefsOrCats;
  }
  const floor = SEVERITY_FLOORS[prefs.minSeverity];
  const ageCutoffMs =
    prefs.maxAgeHours != null
      ? Date.now() - prefs.maxAgeHours * 3600_000
      : null;

  return incidents
    .filter(
      (inc) =>
        inc.lat != null &&
        inc.lng != null &&
        (inc.w_eff ?? 0) >= floor &&
        (prefs.leaves.size === 0 || prefs.leaves.has(inc.severity_category)) &&
        (ageCutoffMs == null ||
          new Date(inc.reported_at).getTime() >= ageCutoffMs)
    )
    .map((inc) => ({
      center: [inc.lat!, inc.lng!] as [number, number],
      radiusM: 150 + (inc.w_eff ?? 0.5) * 200,
    }));
}

/** Hard ceiling on how many `avoid_polygons` we'll send to ORS. The
 *  service rejects oversized requests (and even when it accepts, perf
 *  collapses past a few hundred shapes). When historical time windows
 *  push us past this we drop the lowest-weight clusters. */
export const MAX_AVOID_ZONES = 200;

/** Greedy clustering pass over a list of avoid zones. Each cluster
 *  swallows any zone whose center is inside (its radius + the new
 *  zone's radius), recomputing a weighted centroid and an enlarged
 *  radius that fully contains both inputs. Returns at most
 *  `MAX_AVOID_ZONES` clusters; anything past the cap is dropped
 *  starting from the lowest-weighted. */
export function mergeAvoidZones(zones: AvoidZone[]): AvoidZone[] {
  if (zones.length <= 1) return zones.slice();

  // Local working copy with a weight scalar so the centroid math has
  // somewhere to accumulate. We reuse `radiusM` directly as the weight
  // so larger / more-confident incidents dominate the merge result.
  interface Cluster {
    center: [number, number];
    radiusM: number;
    weight: number;
  }
  const sorted = [...zones].sort((a, b) => b.radiusM - a.radiusM);
  const clusters: Cluster[] = [];
  for (const z of sorted) {
    let merged = false;
    for (const c of clusters) {
      const d = haversineMeters(c.center, z.center);
      if (d <= c.radiusM + z.radiusM) {
        // Weighted centroid (lat/lng combined separately is fine at
        // city scale).
        const w1 = c.weight, w2 = z.radiusM;
        const wTot = w1 + w2;
        c.center = [
          (c.center[0] * w1 + z.center[0] * w2) / wTot,
          (c.center[1] * w1 + z.center[1] * w2) / wTot,
        ];
        c.radiusM = Math.max(c.radiusM, d + z.radiusM);
        c.weight = wTot;
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({ center: z.center, radiusM: z.radiusM, weight: z.radiusM });
    }
  }

  // Cap to MAX_AVOID_ZONES, keeping the heaviest clusters.
  clusters.sort((a, b) => b.weight - a.weight);
  return clusters.slice(0, MAX_AVOID_ZONES).map((c) => ({
    center: c.center,
    radiusM: c.radiusM,
  }));
}

/** Great-circle distance between two [lat, lng] pairs, in meters. */
function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function buildAvoidPolygons(
  zones: AvoidZone[]
): GeoJSON.MultiPolygon | null {
  if (zones.length === 0) return null;
  // Always run the merge pass: at typical (sub-day) windows it's a near
  // no-op (few or no overlaps), but at month/3-month windows it keeps
  // the request under the MAX_AVOID_ZONES ceiling so ORS will accept it.
  const merged = mergeAvoidZones(zones);
  const polygons = merged.map((z) =>
    [circleToPolygon(z.center[0], z.center[1], z.radiusM)]
  );
  return {
    type: "MultiPolygon",
    coordinates: polygons,
  };
}

/** Check if a point is within `thresholdKm` of any segment of a route. */
/** Returns the (approximate) distance in meters along `route` from the
 *  point on the polyline closest to `point`. Used to decide whether
 *  an incident is "ahead of" the user vs already passed: if the
 *  incident's projected distance is greater than the user's, it's
 *  ahead. Polyline is treated as a sequence of great-circle segments
 *  but accumulated with simple haversine — accuracy is plenty at
 *  city-block scale. */
export function distanceAlongRoute(
  point: [number, number],
  route: [number, number][]
): { alongM: number; offsetM: number } | null {
  if (route.length < 2) return null;
  let bestAlong = 0;
  let bestOffset = Infinity;
  let cumulative = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const segLen = haversineMetersAB(a, b);
    // Project point onto segment in equirectangular space (cheap).
    const proj = projectOntoSegment(point, a, b);
    const dToProj = haversineMetersAB(point, proj.point);
    if (dToProj < bestOffset) {
      bestOffset = dToProj;
      bestAlong = cumulative + proj.t * segLen;
    }
    cumulative += segLen;
  }
  return { alongM: bestAlong, offsetM: bestOffset };
}

function haversineMetersAB(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function projectOntoSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): { point: [number, number]; t: number } {
  // Tiny equirectangular projection centered on `a` so we can do plane
  // dot products. At Philly latitudes the error vs spherical is well
  // below the radii we care about (10s of meters).
  const cosLat = Math.cos((a[0] * Math.PI) / 180);
  const ax = 0, ay = 0;
  const bx = (b[1] - a[1]) * cosLat, by = b[0] - a[0];
  const px = (p[1] - a[1]) * cosLat, py = p[0] - a[0];
  const dx = bx - ax, dy = by - ay;
  const segLenSq = dx * dx + dy * dy;
  if (segLenSq === 0) return { point: a, t: 0 };
  let t = ((px - ax) * dx + (py - ay) * dy) / segLenSq;
  t = Math.max(0, Math.min(1, t));
  return {
    point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
    t,
  };
}

export function isNearRoute(
  lat: number,
  lng: number,
  route: [number, number][],
  thresholdKm = 0.5
): boolean {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  for (let i = 0; i < route.length - 1; i += 3) {
    const j = Math.min(i + 3, route.length - 1);
    const aLat = toRad(route[i][0]), aLng = toRad(route[i][1]);
    const bLat = toRad(route[j][0]), bLng = toRad(route[j][1]);
    const pLat = toRad(lat), pLng = toRad(lng);
    const dAP = Math.acos(
      Math.min(1, Math.sin(aLat) * Math.sin(pLat) + Math.cos(aLat) * Math.cos(pLat) * Math.cos(pLng - aLng))
    ) * R;
    if (dAP < thresholdKm) return true;
    const dBP = Math.acos(
      Math.min(1, Math.sin(bLat) * Math.sin(pLat) + Math.cos(bLat) * Math.cos(pLat) * Math.cos(pLng - bLng))
    ) * R;
    if (dBP < thresholdKm) return true;
  }
  return false;
}

function decodePolyline(encoded: string): [number, number][] {
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

/**
 * Street-level routing through the PhillyPulse routing proxy
 * (/api/route-directions). The proxy owns the provider/profile mapping
 * so each UI mode can get mode-specific geometry and fallback timing.
 */
async function getRouteOSRM(
  mode: TransportMode,
  waypoints: [number, number][],
  isSafe = false,
  routePref?: "avoid_traffic",
  crashAvoid?: [number, number][]
): Promise<RouteResult | null> {
  if (waypoints.length < 2) return null;
  try {
    const res = await fetch(routeDirectionsUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waypoints, mode, routePref, crashAvoid }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      geometry?: [number, number][];
      distanceKm?: number;
      durationMin?: number;
      estimated?: boolean;
      durationNoTrafficMin?: number;
      trafficDelayMin?: number;
      trafficSource?: "tomtom";
      congestion?: CongestionSpan[];
      avoidedCrashes?: number;
      steps?: ManeuverStep[];
    };
    if (!data.geometry || !Array.isArray(data.geometry) || data.geometry.length < 2) {
      return null;
    }
    return {
      geometry: data.geometry,
      distanceKm: data.distanceKm ?? 0,
      durationMin: data.durationMin ?? 0,
      isSafe,
      estimated: data.estimated,
      durationNoTrafficMin: data.durationNoTrafficMin,
      trafficDelayMin: data.trafficDelayMin,
      trafficSource: data.trafficSource,
      congestion: data.congestion,
      avoidedCrashes: data.avoidedCrashes,
      steps: Array.isArray(data.steps) && data.steps.length > 0 ? data.steps : undefined,
    };
  } catch {
    return null;
  }
}

/** Join consecutive leg geometries (drop duplicate seam points). */
function mergeRouteLegs(legs: [number, number][][]): [number, number][] {
  const out: [number, number][] = [];
  const close = (a: [number, number], b: [number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-4;

  for (const leg of legs) {
    if (leg.length === 0) continue;
    if (out.length === 0) {
      out.push(...leg);
      continue;
    }
    let start = 0;
    if (close(leg[0], out[out.length - 1])) start = 1;
    for (let j = start; j < leg.length; j++) out.push(leg[j]);
  }
  return out;
}

/**
 * Multi-via routing as A→B, B→C, … then merge. More reliable than one OSRM call on public demo.
 */
async function getRouteOSRMChained(
  mode: TransportMode,
  waypoints: [number, number][],
  isSafe = false,
  routePref?: "avoid_traffic",
  crashAvoid?: [number, number][]
): Promise<RouteResult | null> {
  if (waypoints.length < 2) return null;
  const geometries: [number, number][][] = [];
  let distanceKm = 0;
  let durationMin = 0;
  let durationNoTrafficMin = 0;
  let trafficDelayMin = 0;
  let avoidedCrashes = 0;
  let anyTraffic = false;
  const congestion: CongestionSpan[] = [];
  const steps: ManeuverStep[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const leg = await getRouteOSRM(
      mode,
      [waypoints[i], waypoints[i + 1]],
      isSafe,
      routePref,
      crashAvoid
    );
    if (!leg) return null;
    // Offset this leg's congestion indices by the points already merged
    // (minus the seam point mergeRouteLegs drops between legs).
    const base = geometries.length === 0 ? 0 : Math.max(0, mergeRouteLegs(geometries).length - 1);
    for (const c of leg.congestion ?? []) {
      congestion.push({ fromIdx: c.fromIdx + base, toIdx: c.toIdx + base, level: c.level });
    }
    for (const step of leg.steps ?? []) {
      steps.push({
        ...step,
        way_points: [
          Math.max(0, step.way_points[0] + base),
          Math.max(0, step.way_points[1] + base),
        ],
      });
    }
    geometries.push(leg.geometry);
    distanceKm += leg.distanceKm;
    durationMin += leg.durationMin;
    durationNoTrafficMin += leg.durationNoTrafficMin ?? leg.durationMin;
    trafficDelayMin += leg.trafficDelayMin ?? 0;
    avoidedCrashes += leg.avoidedCrashes ?? 0;
    if (leg.trafficSource === "tomtom") anyTraffic = true;
  }
  const geometry = mergeRouteLegs(geometries);
  if (geometry.length < 2) return null;
  return {
    geometry,
    distanceKm,
    durationMin,
    isSafe,
    ...(anyTraffic
      ? {
          durationNoTrafficMin,
          trafficDelayMin,
          trafficSource: "tomtom" as const,
          congestion: congestion.length ? congestion : undefined,
          ...(avoidedCrashes > 0 ? { avoidedCrashes } : {}),
        }
      : {}),
    steps: steps.length ? steps : undefined,
  };
}

/** Try ORS first, then fall back to OSRM for street-level routing */
export async function getRoute(
  apiKey: string,
  mode: TransportMode,
  start: [number, number],
  end: [number, number],
  avoidPolygons?: GeoJSON.MultiPolygon | null
): Promise<RouteResult | null> {
  return getMultiStopRoute(apiKey, mode, [start, end], avoidPolygons);
}

export interface RouteRequestOptions {
  /** When set, ORS will compute up to this many alternative routes in
   *  addition to the primary. ORS caps practical N at ~3. Each result
   *  comes back as its own RouteResult in `getMultiRouteVariants`. */
  alternatives?: number;
  /** Road features to avoid (driving mode only). */
  avoidFeatures?: AvoidFeature[];
  /** Driving only: `"avoid_traffic"` asks the traffic provider for the
   *  route that spends the least time stuck in congestion, even if its
   *  total distance is longer ("I'd rather drive farther than sit"). */
  routePref?: "avoid_traffic";
  /** Driving only: candidate fresh-crash points [lat,lng] from CityPulse
   *  scanners. The proxy only re-routes around the ones that land on the
   *  computed route, so off-route crashes never cause a detour. */
  crashAvoid?: [number, number][];
}

/**
 * Try the dedicated transit endpoint (/api/transit-directions) which
 * proxies to an OTP server. Returns null when OTP is not configured
 * (501), not reachable, or doesn't find a route — the caller should
 * fall back to foot-walking via ORS.
 */
async function tryTransitRoute(
  apiKey: string,
  origin: [number, number],
  dest: [number, number],
  mode: TransportMode
): Promise<RouteResult | null> {
  try {
    const otpMode = mode === "transit-subway" ? "SUBWAY" : "RAIL";
    const res = await fetch("/api/transit-directions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: [origin[0], origin[1]],
        destination: [dest[0], dest[1]],
        mode: otpMode,
      }),
    });
    
    // If we get a 501 (Not Implemented / OTP not deployed), build a mock route
    // that routes the user to the nearest station via walking, then draws a 
    // straight line to the destination's nearest station, then walks to destination.
    // This provides a graceful "navigate to the train station" UX without OTP.
    if (res.status === 501) {
      const getNearestStation = async (lat: number, lng: number) => {
        const query = `[out:json][timeout:5];(node["railway"~"station"](around:2500,${lat},${lng});way["railway"~"station"](around:2500,${lat},${lng});node["station"~"subway|light_rail|train"](around:2500,${lat},${lng}););out center 1;`;
        try {
          const overpassRes = await fetch("https://overpass-api.de/api/interpreter", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `data=${encodeURIComponent(query)}`,
          });
          const data = await overpassRes.json();
          const el = data.elements?.[0];
          if (!el) return null;
          return [el.lat ?? el.center?.lat, el.lon ?? el.center?.lon] as [number, number];
        } catch {
          return null;
        }
      };

      const [startStation, endStation] = await Promise.all([
        getNearestStation(origin[0], origin[1]),
        getNearestStation(dest[0], dest[1])
      ]);

      if (startStation && endStation) {
        // Get walking route to the start station
        const walkToStation = await getMultiRouteVariants(apiKey, "foot-walking", [origin, startStation]);
        // Get walking route from end station to destination
        const walkFromStation = await getMultiRouteVariants(apiKey, "foot-walking", [endStation, dest]);
        
        const w1 = walkToStation[0];
        const w2 = walkFromStation[0];
        
        if (w1 && w2) {
          return {
            geometry: [...w1.geometry, endStation, ...w2.geometry],
            distanceKm: w1.distanceKm + w2.distanceKm + 5.0, // rough 5km estimate for transit line
            durationMin: w1.durationMin + w2.durationMin + 20, // rough 20m transit ride
            isSafe: false
          };
        }
      }
      return null;
    }

    if (!res.ok) return null;
    const data = (await res.json()) as {
      itineraries?: Array<{
        id: string;
        durationMin: number;
        legs: Array<{
          mode: string;
          from: { lat: number; lng: number };
          to: { lat: number; lng: number };
          encodedPolyline?: string | null;
        }>;
      }>;
    };
    const itin = data.itineraries?.[0];
    if (!itin || !itin.legs || itin.legs.length === 0) return null;

    // Build a geometry from the leg endpoints (simplified; a full
    // implementation would decode each leg's polyline).
    const geometry: [number, number][] = [];
    for (const leg of itin.legs) {
      geometry.push([leg.from.lat, leg.from.lng]);
    }
    const lastLeg = itin.legs[itin.legs.length - 1];
    geometry.push([lastLeg.to.lat, lastLeg.to.lng]);

    // Compute rough distance from legs
    let totalDistM = 0;
    for (let i = 1; i < geometry.length; i++) {
      const [lat1, lng1] = geometry[i - 1];
      const [lat2, lng2] = geometry[i];
      const R = 6371000;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      totalDistM += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    return {
      geometry,
      distanceKm: totalDistM / 1000,
      durationMin: itin.durationMin,
      isSafe: false,
    };
  } catch {
    return null;
  }
}

export async function getMultiStopRoute(
  apiKey: string,
  mode: TransportMode,
  waypoints: [number, number][],
  avoidPolygons?: GeoJSON.MultiPolygon | null,
  options?: RouteRequestOptions
): Promise<RouteResult | null> {
  // For transit modes, try the OTP backend first. Only works for
  // simple origin→dest (no intermediate stops via OTP).
  if (isTransitMode(mode) && waypoints.length === 2) {
    const transitResult = await tryTransitRoute(apiKey, waypoints[0], waypoints[1], mode);
    if (transitResult) return transitResult;
    // OTP/Fallback not available — fall through to foot-walking via ORS
  }
  const variants = await getMultiRouteVariants(apiKey, mode, waypoints, avoidPolygons, options);
  return variants[0] ?? null;
}

/** Same as `getMultiStopRoute` but returns every alternative ORS sent
 *  back (primary + up to `options.alternatives` more). Falls back to a
 *  single OSRM result when ORS is unavailable. */
export async function getMultiRouteVariants(
  apiKey: string,
  mode: TransportMode,
  waypoints: [number, number][],
  avoidPolygons?: GeoJSON.MultiPolygon | null,
  options?: RouteRequestOptions
): Promise<RouteResult[]> {
  if (waypoints.length < 2) return [];

  // Browser calls to ORS are blocked by CORS; route through our API proxy instead.
  if (typeof window !== "undefined") {
    const isSafe = !!avoidPolygons;
    let osrm = await getRouteOSRM(mode, waypoints, isSafe, options?.routePref, options?.crashAvoid);
    if (!osrm && waypoints.length > 2) {
      osrm = await getRouteOSRMChained(mode, waypoints, isSafe, options?.routePref, options?.crashAvoid);
    }
    return osrm ? [osrm] : [];
  }

  // Try ORS first (supports avoidance polygons + alternatives)
  const body: Record<string, unknown> = {
    coordinates: waypoints.map(([lat, lng]) => [lng, lat]),
  };

  const orsOptions: Record<string, unknown> = {};
  if (avoidPolygons && avoidPolygons.coordinates.length > 0) {
    orsOptions.avoid_polygons = avoidPolygons;
  }
  if (options?.avoidFeatures && options.avoidFeatures.length > 0) {
    orsOptions.avoid_features = options.avoidFeatures;
  }
  if (Object.keys(orsOptions).length > 0) {
    body.options = orsOptions;
  }
  if (options?.alternatives && options.alternatives > 0) {
    // ORS caps target_count at 3. share_factor & weight_factor tuned to
    // produce visibly distinct alternates rather than near-duplicates.
    body.alternative_routes = {
      target_count: Math.min(3, options.alternatives + 1),
      share_factor: 0.6,
      weight_factor: 1.4,
    };
  }

  try {
    const res = await fetch(`${ORS_URL}/${orsProfile(mode)}`, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json();
      const routesRaw = Array.isArray(data.routes) ? data.routes : [];
      const out: RouteResult[] = [];
      for (const route of routesRaw) {
        const geometry = decodePolyline(route.geometry);
        const steps: ManeuverStep[] = [];
        if (Array.isArray(route.segments)) {
          for (const seg of route.segments) {
            if (!Array.isArray(seg.steps)) continue;
            for (const s of seg.steps) {
              steps.push({
                instruction: String(s.instruction ?? ""),
                distance: Number(s.distance ?? 0),
                duration: Number(s.duration ?? 0),
                type: Number(s.type ?? 0),
                way_points: [Number(s.way_points?.[0] ?? 0), Number(s.way_points?.[1] ?? 0)],
                name: typeof s.name === "string" && s.name !== "-" ? s.name : undefined,
              });
            }
          }
        }
        out.push({
          geometry,
          distanceKm: route.summary.distance / 1000,
          durationMin: route.summary.duration / 60,
          isSafe: !!avoidPolygons,
          steps: steps.length > 0 ? steps : undefined,
          avoidedFeatures: options?.avoidFeatures,
        });
      }
      if (out.length > 0) return out;
    }
  } catch {
    // ORS failed, will try OSRM below
  }

  const isSafe = !!avoidPolygons;
  // OSRM via backend proxy (street geometry) — single route only.
  let osrm = await getRouteOSRM(mode, waypoints, isSafe);
  if (!osrm && waypoints.length > 2) {
    osrm = await getRouteOSRMChained(mode, waypoints, isSafe);
  }
  return osrm ? [osrm] : [];
}

/** Cheap geometry similarity: returns true when two routes share ≥ `min`
 *  fraction of points (rounded to ~10m grid). Used to dedupe ORS
 *  alternates that come back nearly identical to the primary route. */
function geometriesAreSimilar(
  a: [number, number][],
  b: [number, number][],
  min = 0.85
): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const key = (p: [number, number]) =>
    `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const setA = new Set(a.map(key));
  let hits = 0;
  for (const p of b) {
    if (setA.has(key(p))) hits++;
  }
  const overlap = hits / Math.min(a.length, b.length);
  return overlap >= min;
}

interface RouteVariantsRequest {
  apiKey: string;
  mode: TransportMode;
  waypoints: [number, number][];
  /** Pre-built avoidance polygons (incident zones). When provided, a
   *  "safer" variant will be requested in parallel with the direct one. */
  avoidPolygons: GeoJSON.MultiPolygon | null;
  /** Whether to also request avoid-tollways / avoid-highways variants
   *  (only meaningful for driving mode — caller should pre-filter). */
  includeRoadFeatureVariants?: boolean;
  /** Driving only: prefer the lowest-time-in-traffic route (see
   *  `RouteRequestOptions.routePref`). Applied to the primary variant. */
  routePref?: "avoid_traffic";
  /** Driving only: fresh-crash points [lat,lng] to route around if they
   *  land on the route (see `RouteRequestOptions.crashAvoid`). */
  crashAvoid?: [number, number][];
}

/** Fetches every variant we want to surface in the route picker
 *  (direct + alternates + safer + avoid-tolls + avoid-highways) in
 *  parallel, then dedupes near-identical geometries and returns a
 *  ranked list of `RouteOption`s ready to render. */
export async function getRouteOptions(
  req: RouteVariantsRequest
): Promise<RouteOption[]> {
  const { apiKey, mode, waypoints, avoidPolygons, includeRoadFeatureVariants, routePref, crashAvoid } = req;
  if (waypoints.length < 2) return [];

  const featureVariantsRequested = includeRoadFeatureVariants && mode === "driving-car";

  const [direct, safer, noTolls, noHighways] = await Promise.all([
    getMultiRouteVariants(apiKey, mode, waypoints, null, { alternatives: 2, routePref, crashAvoid }),
    avoidPolygons ? getMultiRouteVariants(apiKey, mode, waypoints, avoidPolygons) : Promise.resolve([]),
    featureVariantsRequested
      ? getMultiRouteVariants(apiKey, mode, waypoints, null, { avoidFeatures: ["tollways"] })
      : Promise.resolve([]),
    featureVariantsRequested
      ? getMultiRouteVariants(apiKey, mode, waypoints, null, { avoidFeatures: ["highways"] })
      : Promise.resolve([]),
  ]);

  const collected: RouteOption[] = [];
  const pushUnique = (opt: RouteOption) => {
    for (const existing of collected) {
      if (geometriesAreSimilar(existing.route.geometry, opt.route.geometry)) {
        // Prefer the option with the better label specificity ("Safer" /
        // "No tolls" beat the generic "Fastest" / "Alternate").
        if (
          (opt.isSafer && !existing.isSafer) ||
          (opt.avoidedFeatures.length > 0 && existing.avoidedFeatures.length === 0)
        ) {
          const idx = collected.indexOf(existing);
          collected[idx] = opt;
        }
        return;
      }
    }
    collected.push(opt);
  };

  direct.forEach((r, i) => {
    pushUnique({
      id: `direct-${i}`,
      label: i === 0 ? "Fastest" : `Alternate ${i}`,
      route: r,
      isSafer: false,
      avoidedFeatures: [],
    });
  });

  safer.forEach((r, i) =>
    pushUnique({
      id: `safer-${i}`,
      label: "Safer",
      subtitle: "Avoids reported incidents",
      route: { ...r, isSafe: true },
      isSafer: true,
      avoidedFeatures: [],
    })
  );

  noTolls.forEach((r, i) =>
    pushUnique({
      id: `no-tolls-${i}`,
      label: "No tolls",
      route: { ...r, avoidedFeatures: ["tollways"] },
      isSafer: false,
      avoidedFeatures: ["tollways"],
    })
  );

  noHighways.forEach((r, i) =>
    pushUnique({
      id: `no-highways-${i}`,
      label: "No highways",
      route: { ...r, avoidedFeatures: ["highways"] },
      isSafer: false,
      avoidedFeatures: ["highways"],
    })
  );

  // Sort: safer first (when present), then by ETA ascending.
  collected.sort((a, b) => {
    if (a.isSafer !== b.isSafer) return a.isSafer ? -1 : 1;
    return a.route.durationMin - b.route.durationMin;
  });

  return collected;
}
