/** "Search along route" geometry helpers.
 *
 *  Given an active trip's polyline, compute:
 *    - a bounding box (with margin) for issuing a single POI query
 *    - per-POI detour cost = distance along route to the closest point
 *      on the polyline, plus 2× perpendicular distance to that point
 *      (out and back). This is a useful proxy for "how much extra
 *      driving does this stop cost me?" without rerouting through
 *      a real routing engine.
 *
 *  The math is intentionally cheap (equirectangular projection) since
 *  it runs on dozens of POIs per query and is consumer-fast at city
 *  scale. For inter-city routes that span more than ~50km of latitude,
 *  switch the projection — but our trip recap shows ~3km median so the
 *  approximation is fine.
 */

export interface RoutePoint {
  lat: number;
  lng: number;
}

export interface AlongRoutePoiInput {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Pass-through opening_hours from Overpass so consumers (the
   *  AlongRoutePanel list) can render an "Open · closes 9 PM" badge
   *  without re-fetching. */
  openingHours?: string;
  /** Pass-through OSM accessibility tag. Same shape as Poi.wheelchair. */
  wheelchair?: "yes" | "limited" | "no";
  /** Pass-through contact tags so the search-along-route list can
   *  surface tap-to-call / open-website without a second lookup. */
  phone?: string;
  website?: string;
}

export interface AlongRoutePoi extends AlongRoutePoiInput {
  /** Meters from the polyline at the closest snap point. */
  perpM: number;
  /** Round-trip detour cost in meters: 2 × perpM. */
  detourM: number;
  /** Forward distance along the polyline from its origin to the snap
   *  point — useful for ordering "next gas station ahead" results. */
  alongM: number;
}

/** Bounding box around a polyline, padded outward by `marginM` meters. */
export function polylineBbox(
  polyline: RoutePoint[],
  marginM = 500
): { south: number; west: number; north: number; east: number } | null {
  if (polyline.length === 0) return null;
  let south = polyline[0].lat, north = polyline[0].lat;
  let west = polyline[0].lng,  east = polyline[0].lng;
  for (const p of polyline) {
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
    if (p.lng < west)  west  = p.lng;
    if (p.lng > east)  east  = p.lng;
  }
  // Convert margin meters → degrees. 1 deg lat ≈ 111_320m; 1 deg lng
  // shrinks with cos(lat) — use the box midpoint as the linearization
  // point for the lng correction.
  const midLat = (south + north) / 2;
  const dLat = marginM / 111_320;
  const dLng = marginM / (111_320 * Math.max(0.1, Math.cos(midLat * Math.PI / 180)));
  return {
    south: south - dLat,
    north: north + dLat,
    west:  west  - dLng,
    east:  east  + dLng,
  };
}

/** Squared meter distance from `p` to segment `a-b` plus the
 *  fractional position `t` of the snap point along that segment. */
function snapToSegment(
  p: RoutePoint, a: RoutePoint, b: RoutePoint, cosLat: number
): { distM: number; t: number } {
  const ax = a.lng * cosLat, ay = a.lat;
  const bx = b.lng * cosLat, by = b.lat;
  const px = p.lng * cosLat, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const nx = ax + t * dx, ny = ay + t * dy;
  const distDeg = Math.hypot(px - nx, py - ny);
  return { distM: distDeg * 111_320, t };
}

/** Snap each candidate POI to the closest point on the polyline, then
 *  filter & rank by detour cost. Returns the top `maxResults` ordered
 *  by ascending total detour, ignoring POIs farther than `maxPerpM`
 *  from the polyline.
 *
 *  We compute a *single* meanLat → cosLat factor for the whole route
 *  rather than per segment because at city scale the error is < 1m for
 *  any sane polyline length, and skipping the per-iteration cos saves
 *  a lot of cycles when there are many POIs. */
export function rankAlongRoute(
  polyline: RoutePoint[],
  pois: AlongRoutePoiInput[],
  opts: { maxPerpM?: number; maxResults?: number } = {}
): AlongRoutePoi[] {
  const maxPerpM   = opts.maxPerpM   ?? 500;
  const maxResults = opts.maxResults ?? 12;
  if (polyline.length < 2 || pois.length === 0) return [];

  // Mean latitude → cosLat for equirectangular projection.
  let latSum = 0;
  for (const p of polyline) latSum += p.lat;
  const cosLat = Math.cos((latSum / polyline.length) * Math.PI / 180);

  // Cumulative along-route distance per polyline vertex, in meters.
  // Computed once and reused per POI.
  const cum: number[] = [0];
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1], b = polyline[i];
    const dx = (b.lng - a.lng) * cosLat;
    const dy = (b.lat - a.lat);
    cum.push(cum[i - 1] + Math.hypot(dx, dy) * 111_320);
  }

  const ranked: AlongRoutePoi[] = [];
  for (const poi of pois) {
    let best = { perpM: Infinity, alongM: 0 };
    for (let i = 1; i < polyline.length; i++) {
      const { distM, t } = snapToSegment(poi, polyline[i - 1], polyline[i], cosLat);
      if (distM < best.perpM) {
        const segLen = cum[i] - cum[i - 1];
        best = { perpM: distM, alongM: cum[i - 1] + t * segLen };
      }
    }
    if (best.perpM <= maxPerpM) {
      ranked.push({
        ...poi,
        perpM:   best.perpM,
        detourM: best.perpM * 2,
        alongM:  best.alongM,
      });
    }
  }

  // Lower detour wins; tiebreak by earlier alongM so two
  // equally-close gas stations are presented in the order the driver
  // will pass them.
  ranked.sort((a, b) => (a.detourM - b.detourM) || (a.alongM - b.alongM));
  return ranked.slice(0, maxResults);
}
