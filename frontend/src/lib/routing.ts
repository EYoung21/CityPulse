import type { Incident } from "./api";

const ORS_URL = "https://api.openrouteservice.org/v2/directions";

/** Same base as `lib/api.ts` so routing hits the backend when using NEXT_PUBLIC_API_URL. */
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

function routeDirectionsUrl(): string {
  return `${API_BASE}/api/route-directions`;
}

export type TransportMode = "foot-walking" | "cycling-regular" | "driving-car";

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
}

export interface RouteResult {
  geometry: [number, number][];
  distanceKm: number;
  durationMin: number;
  isSafe: boolean;
  steps?: ManeuverStep[];
  /** ORS-defined road features avoided when this route was computed
   *  (e.g. ["tollways", "highways"]). Empty/undefined when the call was
   *  not constrained. */
  avoidedFeatures?: string[];
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

export const DEFAULT_AVOID_CATS: Set<AvoidCategoryId> = new Set(["violent", "fire"]);

export function buildAvoidZones(
  incidents: Incident[],
  avoidCats?: Set<AvoidCategoryId>
): AvoidZone[] {
  const cats = avoidCats ?? DEFAULT_AVOID_CATS;
  const allowedSeverityCats = new Set<string>();
  for (const ac of AVOIDANCE_CATEGORIES) {
    if (cats.has(ac.id)) {
      for (const c of ac.cats) allowedSeverityCats.add(c);
    }
  }

  return incidents
    .filter(
      (inc) =>
        inc.lat != null &&
        inc.lng != null &&
        (inc.w_eff ?? 0) > 0.25 &&
        (allowedSeverityCats.size === 0 || allowedSeverityCats.has(inc.severity_category))
    )
    .map((inc) => ({
      center: [inc.lat!, inc.lng!] as [number, number],
      radiusM: 150 + (inc.w_eff ?? 0.5) * 200,
    }));
}

export function buildAvoidPolygons(
  zones: AvoidZone[]
): GeoJSON.MultiPolygon | null {
  if (zones.length === 0) return null;
  const polygons = zones.map((z) =>
    [circleToPolygon(z.center[0], z.center[1], z.radiusM)]
  );
  return {
    type: "MultiPolygon",
    coordinates: polygons,
  };
}

/** Check if a point is within `thresholdKm` of any segment of a route. */
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
 * Street-level routing via OSRM, proxied through PhillyPulse API (/api/route-directions).
 * Direct browser calls to router.project-osrm.org are blocked by CORS, so we never hit OSRM from the client.
 */
async function getRouteOSRM(
  mode: TransportMode,
  waypoints: [number, number][],
  isSafe = false
): Promise<RouteResult | null> {
  if (waypoints.length < 2) return null;
  try {
    const res = await fetch(routeDirectionsUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waypoints, mode }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      geometry?: [number, number][];
      distanceKm?: number;
      durationMin?: number;
    };
    if (!data.geometry || !Array.isArray(data.geometry) || data.geometry.length < 2) {
      return null;
    }
    return {
      geometry: data.geometry,
      distanceKm: data.distanceKm ?? 0,
      durationMin: data.durationMin ?? 0,
      isSafe,
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
  isSafe = false
): Promise<RouteResult | null> {
  if (waypoints.length < 2) return null;
  const geometries: [number, number][][] = [];
  let distanceKm = 0;
  let durationMin = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const leg = await getRouteOSRM(
      mode,
      [waypoints[i], waypoints[i + 1]],
      isSafe
    );
    if (!leg) return null;
    geometries.push(leg.geometry);
    distanceKm += leg.distanceKm;
    durationMin += leg.durationMin;
  }
  const geometry = mergeRouteLegs(geometries);
  if (geometry.length < 2) return null;
  return { geometry, distanceKm, durationMin, isSafe };
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
}

export async function getMultiStopRoute(
  apiKey: string,
  mode: TransportMode,
  waypoints: [number, number][],
  avoidPolygons?: GeoJSON.MultiPolygon | null,
  options?: RouteRequestOptions
): Promise<RouteResult | null> {
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
    const res = await fetch(`${ORS_URL}/${mode}`, {
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
}

/** Fetches every variant we want to surface in the route picker
 *  (direct + alternates + safer + avoid-tolls + avoid-highways) in
 *  parallel, then dedupes near-identical geometries and returns a
 *  ranked list of `RouteOption`s ready to render. */
export async function getRouteOptions(
  req: RouteVariantsRequest
): Promise<RouteOption[]> {
  const { apiKey, mode, waypoints, avoidPolygons, includeRoadFeatureVariants } = req;
  if (waypoints.length < 2) return [];

  const featureVariantsRequested = includeRoadFeatureVariants && mode === "driving-car";

  const [direct, safer, noTolls, noHighways] = await Promise.all([
    getMultiRouteVariants(apiKey, mode, waypoints, null, { alternatives: 2 }),
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
