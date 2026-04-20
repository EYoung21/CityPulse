/** Per-route safety scoring.
 *
 *  For each route alternative we count how many recent incidents fall
 *  within a "corridor" around the polyline (default 120 m perpendicular).
 *  The result is rendered as a concrete number on the RouteOptionPicker
 *  ("3 nearby") instead of just a binary "Safer" badge — so users can
 *  see _how much_ safer one option is than another.
 *
 *  We deliberately don't reuse the global heatmap weights here. Those
 *  are tuned for a smoothed continuous surface; for route comparison we
 *  want a hard "is this incident close enough to the path that a driver
 *  could be exposed to it" decision. 120 m matches the lane-width-plus-
 *  one-block heuristic we use in the `incident-ahead` chip.
 */

import type { Incident } from "@/lib/api";
import { severityBucket, SEVERITY_HEAT_MULTIPLIER, type SeverityBucket } from "@/lib/severity";

export interface RouteSafetyScore {
  /** Number of incidents whose closest point on the route polyline is
   *  within `marginM` meters. */
  count: number;
  /** Severity-weighted exposure (sum of per-incident heatmap-multipliers).
   *  Higher = more dangerous corridor. We reuse the same multiplier
   *  table the heatmap renders so the picker and the heat surface
   *  agree on which categories matter. */
  weighted: number;
  /** Per-bucket counts for tooltips / power-user surfaces. */
  bySeverity: Record<SeverityBucket, number>;
}

const ZERO_BUCKETS = (): Record<SeverityBucket, number> => ({
  violent: 0, fire: 0, medical: 0, property: 0, traffic: 0, other: 0,
});

const EARTH_R_M = 6_371_000;

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Equirectangular projection meters relative to a reference lat —
 *  cheap and accurate enough for sub-1km segments at city scale. */
function project(
  lat: number,
  lng: number,
  refLat: number
): { x: number; y: number } {
  const cosRef = Math.cos(toRad(refLat));
  return {
    x: toRad(lng) * EARTH_R_M * cosRef,
    y: toRad(lat) * EARTH_R_M,
  };
}

/** Closest perpendicular distance (meters) from point P to segment AB,
 *  using projected meters. Caller is responsible for picking a sensible
 *  reference latitude. */
function perpDistanceM(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ddx = px - ax;
    const ddy = py - ay;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  // Clamp the projection parameter to [0,1] so we measure to the
  // segment, not the infinite line.
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Bounding-box prefilter so we don't run perp-distance against every
 *  incident in the city. Returns the [south, west, north, east] of the
 *  polyline expanded by `marginM` meters. */
function polylineBounds(
  geometry: [number, number][],
  marginM: number
): { south: number; west: number; north: number; east: number } | null {
  if (geometry.length === 0) return null;
  let south = geometry[0][0], north = geometry[0][0];
  let west = geometry[0][1], east = geometry[0][1];
  for (const [lat, lng] of geometry) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
  }
  const midLat = (south + north) / 2;
  const dLat = marginM / 111_320;
  const dLng = marginM / (111_320 * Math.max(0.1, Math.cos(toRad(midLat))));
  return {
    south: south - dLat,
    north: north + dLat,
    west: west - dLng,
    east: east + dLng,
  };
}

/** Score a single route polyline against the current incident set.
 *  Pure / synchronous — safe to call per render or memoize as needed. */
export function scoreRouteSafety(
  geometry: [number, number][],
  incidents: Incident[],
  marginM = 120
): RouteSafetyScore {
  const empty: RouteSafetyScore = {
    count: 0,
    weighted: 0,
    bySeverity: ZERO_BUCKETS(),
  };
  if (geometry.length < 2 || incidents.length === 0) return empty;

  const bounds = polylineBounds(geometry, marginM);
  if (!bounds) return empty;

  // Project once per call using the polyline midpoint as the reference
  // latitude — same accuracy/speed trade-off as `lib/along-route`.
  const refLat = (bounds.south + bounds.north) / 2;
  const projected = geometry.map(([lat, lng]) => project(lat, lng, refLat));

  let count = 0;
  let weighted = 0;
  const bySeverity = ZERO_BUCKETS();

  for (const inc of incidents) {
    const lat = inc.lat;
    const lng = inc.lng;
    if (lat == null || lng == null) continue;
    if (lat < bounds.south || lat > bounds.north) continue;
    if (lng < bounds.west  || lng > bounds.east)  continue;
    const { x: px, y: py } = project(lat, lng, refLat);

    let minDist = Infinity;
    for (let i = 1; i < projected.length; i++) {
      const a = projected[i - 1];
      const b = projected[i];
      const d = perpDistanceM(px, py, a.x, a.y, b.x, b.y);
      if (d < minDist) {
        minDist = d;
        if (minDist < 5) break;
      }
    }
    if (minDist <= marginM) {
      count += 1;
      const bucket = severityBucket(inc.severity_category);
      weighted += SEVERITY_HEAT_MULTIPLIER[bucket];
      bySeverity[bucket] += 1;
    }
  }

  return { count, weighted, bySeverity };
}

/** Score every option in a list. Returns a Map keyed by option id so
 *  the picker can look up its score without re-zipping arrays. */
export function scoreRouteOptions<T extends { id: string; route: { geometry: [number, number][] } }>(
  options: T[],
  incidents: Incident[],
  marginM = 120
): Map<string, RouteSafetyScore> {
  const out = new Map<string, RouteSafetyScore>();
  for (const opt of options) {
    out.set(opt.id, scoreRouteSafety(opt.route.geometry, incidents, marginM));
  }
  return out;
}
