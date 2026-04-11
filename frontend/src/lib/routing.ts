import type { Incident } from "./api";

const ORS_URL = "https://api.openrouteservice.org/v2/directions";
const OSRM_URL = "https://router.project-osrm.org/route/v1";

export type TransportMode = "foot-walking" | "cycling-regular" | "driving-car";

export interface RouteResult {
  geometry: [number, number][];
  distanceKm: number;
  durationMin: number;
  isSafe: boolean;
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

export function buildAvoidZones(incidents: Incident[]): AvoidZone[] {
  return incidents
    .filter(
      (inc) => inc.lat != null && inc.lng != null && (inc.w_eff ?? 0) > 0.25
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

const OSRM_PROFILES: Record<TransportMode, string> = {
  "foot-walking": "foot",
  "cycling-regular": "bike",
  "driving-car": "car",
};

async function getRouteOSRM(
  mode: TransportMode,
  waypoints: [number, number][]
): Promise<RouteResult | null> {
  if (waypoints.length < 2) return null;
  const coords = waypoints.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const profile = OSRM_PROFILES[mode] || "car";
  try {
    const res = await fetch(
      `${OSRM_URL}/${profile}/${coords}?overview=full&geometries=geojson`,
      { headers: { "User-Agent": "PHLPulse/0.1" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const route = data.routes?.[0];
    if (!route) return null;
    const geometry: [number, number][] = route.geometry.coordinates.map(
      ([lng, lat]: [number, number]) => [lat, lng]
    );
    return {
      geometry,
      distanceKm: route.distance / 1000,
      durationMin: route.duration / 60,
      isSafe: false,
    };
  } catch {
    return null;
  }
}

export async function getRoute(
  apiKey: string,
  mode: TransportMode,
  start: [number, number],
  end: [number, number],
  avoidPolygons?: GeoJSON.MultiPolygon | null
): Promise<RouteResult | null> {
  return getMultiStopRoute(apiKey, mode, [start, end], avoidPolygons);
}

export async function getMultiStopRoute(
  apiKey: string,
  mode: TransportMode,
  waypoints: [number, number][],
  avoidPolygons?: GeoJSON.MultiPolygon | null
): Promise<RouteResult | null> {
  if (waypoints.length < 2) return null;

  const body: Record<string, unknown> = {
    coordinates: waypoints.map(([lat, lng]) => [lng, lat]),
  };

  if (avoidPolygons && avoidPolygons.coordinates.length > 0) {
    body.options = { avoid_polygons: avoidPolygons };
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

    if (!res.ok) {
      if (!avoidPolygons) return getRouteOSRM(mode, waypoints);
      return null;
    }

    const data = await res.json();
    const route = data.routes?.[0];
    if (!route) {
      if (!avoidPolygons) return getRouteOSRM(mode, waypoints);
      return null;
    }

    const geometry = decodePolyline(route.geometry);
    return {
      geometry,
      distanceKm: route.summary.distance / 1000,
      durationMin: route.summary.duration / 60,
      isSafe: !!avoidPolygons,
    };
  } catch {
    if (!avoidPolygons) return getRouteOSRM(mode, waypoints);
    return null;
  }
}
