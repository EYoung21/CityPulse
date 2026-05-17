"use client";

/** SEPTA real-time helpers.
 *
 *  SEPTA exposes a small set of unauthenticated JSON endpoints (no
 *  signup, no key, no rate-limit headers we can introspect). We proxy
 *  them through /api/septa so the browser never hits SEPTA directly —
 *  that gives us:
 *    * a single User-Agent and IP for SEPTA's traffic
 *    * server-side caching so 10 users tapping the same stop in one
 *      minute = 1 upstream request
 *    * room to add a fallback or graceful 503 if SEPTA flaps.
 *
 *  The lat/lngs in REGIONAL_RAIL_STATIONS are not the full SEPTA
 *  network (that lives in GTFS, ~150 stops). They're the curated set
 *  of high-traffic Regional Rail stations + the Center City subway
 *  hubs — enough that any user inside the SEPTA service area has a
 *  reasonable "nearest stop" answer without us shipping a 50 MB GTFS
 *  bundle to the browser. The `name` field is what we pass to SEPTA's
 *  Arrivals endpoint verbatim (which expects the human station name).
 */

export interface SeptaStation {
  /** Exact name SEPTA's Arrivals API expects (case-sensitive). */
  name: string;
  lat: number;
  lng: number;
  /** "rail" = Regional Rail, "mfl" = Market-Frankford Line, "bsl" =
   *  Broad Street Line. Used purely for the icon on the arrivals card. */
  kind: "rail" | "mfl" | "bsl";
}

/** Curated subset — high-traffic stations across SEPTA Regional Rail
 *  + the two subway lines' major hubs. Add more as we hear from users
 *  about gaps. Coords sourced from SEPTA's published GTFS stops.txt. */
export const SEPTA_STATIONS: readonly SeptaStation[] = [
  // ── Center City hubs ──────────────────────────────────────────
  { name: "Suburban Station",   lat: 39.9544, lng: -75.1683, kind: "rail" },
  { name: "Jefferson Station",  lat: 39.9528, lng: -75.1582, kind: "rail" },
  { name: "30th Street Station", lat: 39.9558, lng: -75.1819, kind: "rail" },
  { name: "Temple U",           lat: 39.9810, lng: -75.1494, kind: "rail" },
  // ── Subway (Market-Frankford) ─────────────────────────────────
  { name: "15th St",            lat: 39.9531, lng: -75.1656, kind: "mfl" },
  { name: "30th St",            lat: 39.9558, lng: -75.1819, kind: "mfl" },
  { name: "69th St Transp Ctr", lat: 39.9697, lng: -75.2588, kind: "mfl" },
  { name: "Frankford Transp Ctr", lat: 40.0099, lng: -75.0796, kind: "mfl" },
  // ── Subway (Broad Street) ─────────────────────────────────────
  { name: "City Hall",          lat: 39.9530, lng: -75.1635, kind: "bsl" },
  { name: "Walnut-Locust",      lat: 39.9476, lng: -75.1655, kind: "bsl" },
  { name: "AT&T Station",       lat: 39.9061, lng: -75.1714, kind: "bsl" },
  { name: "Olney Transp Ctr",   lat: 40.0341, lng: -75.1437, kind: "bsl" },
  // ── Media/Wawa line (Delaware County) ─────────────────────────
  { name: "Swarthmore",         lat: 39.9015, lng: -75.3500, kind: "rail" },
  { name: "Wallingford",        lat: 39.8919, lng: -75.3719, kind: "rail" },
  { name: "Media",              lat: 39.9132, lng: -75.3855, kind: "rail" },
  { name: "Moylan-Rose Valley", lat: 39.8989, lng: -75.3819, kind: "rail" },
  { name: "Wawa",               lat: 39.9249, lng: -75.4523, kind: "rail" },
  { name: "Morton",             lat: 39.9117, lng: -75.3287, kind: "rail" },
  { name: "Secane",             lat: 39.9156, lng: -75.3088, kind: "rail" },
  { name: "Primos",             lat: 39.9234, lng: -75.2962, kind: "rail" },
  { name: "Clifton-Aldan",      lat: 39.9285, lng: -75.2882, kind: "rail" },
  { name: "Gladstone",          lat: 39.9276, lng: -75.2818, kind: "rail" },
  { name: "Lansdowne",          lat: 39.9376, lng: -75.2718, kind: "rail" },
  { name: "Fernwood",           lat: 39.9418, lng: -75.2517, kind: "rail" },
  { name: "Angora",             lat: 39.9457, lng: -75.2389, kind: "rail" },
  // ── Paoli/Thorndale (Main Line) ───────────────────────────────
  { name: "Ardmore",            lat: 40.0035, lng: -75.2914, kind: "rail" },
  { name: "Bryn Mawr",          lat: 40.0212, lng: -75.3142, kind: "rail" },
  { name: "Villanova",          lat: 40.0382, lng: -75.3445, kind: "rail" },
  { name: "Radnor",             lat: 40.0464, lng: -75.3596, kind: "rail" },
  { name: "Wayne",              lat: 40.0438, lng: -75.3879, kind: "rail" },
  { name: "Strafford",          lat: 40.0414, lng: -75.4031, kind: "rail" },
  { name: "Paoli",              lat: 40.0432, lng: -75.4854, kind: "rail" },
  { name: "Thorndale",          lat: 40.0046, lng: -75.7651, kind: "rail" },
  // ── Trenton / West Trenton ────────────────────────────────────
  { name: "Trenton",            lat: 40.2169, lng: -74.7561, kind: "rail" },
  { name: "Cornwells Heights",  lat: 40.0810, lng: -74.9434, kind: "rail" },
  // ── Airport ───────────────────────────────────────────────────
  { name: "Airport Terminal A", lat: 39.8729, lng: -75.2417, kind: "rail" },
  { name: "Airport Terminal B", lat: 39.8742, lng: -75.2424, kind: "rail" },
  { name: "Airport Terminal C-D", lat: 39.8762, lng: -75.2430, kind: "rail" },
  { name: "Airport Terminal E-F", lat: 39.8794, lng: -75.2439, kind: "rail" },
  // ── Chestnut Hill ────────────────────────────────────────────
  { name: "Chestnut Hill East", lat: 40.0717, lng: -75.2090, kind: "rail" },
  { name: "Chestnut Hill West", lat: 40.0760, lng: -75.2155, kind: "rail" },
] as const;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface StationWithDistance {
  station: SeptaStation;
  /** Straight-line distance in km. Not walking distance — for "is
   *  there a station nearby" decisions only. */
  km: number;
}

/** Nearest SEPTA station to a point, or null if all stations are
 *  farther than `maxKm` (default 8 km — outside that and the API's
 *  answers stop being meaningful to the user). */
export function nearestStation(
  lat: number,
  lng: number,
  maxKm = 8
): StationWithDistance | null {
  let best: StationWithDistance | null = null;
  for (const s of SEPTA_STATIONS) {
    const km = haversineKm(lat, lng, s.lat, s.lng);
    if (km > maxKm) continue;
    if (!best || km < best.km) best = { station: s, km };
  }
  return best;
}

export interface SeptaArrival {
  direction: "N" | "S" | string;
  origin: string;
  destination: string;
  /** ISO 8601 scheduled departure. */
  sched_time: string;
  /** ISO 8601 estimated departure (may equal sched_time). */
  depart_time: string;
  /** "On Time", "5 min late", "Cancelled", etc. */
  status: string;
  line: string | null;
  train_id: string;
  track: string;
  service_type: string;
}

export interface SeptaArrivalsResponse {
  station: string;
  /** "May 17, 2026, 5:04 am" — verbatim from SEPTA. */
  fetched_label: string;
  northbound: SeptaArrival[];
  southbound: SeptaArrival[];
}

/** Fetch arrivals for a station via our /api/septa proxy. Throws on
 *  network / 5xx so callers can show an inline error state. */
export async function fetchArrivals(
  station: string,
  signal?: AbortSignal
): Promise<SeptaArrivalsResponse> {
  const params = new URLSearchParams({ op: "arrivals", station });
  const r = await fetch(`/api/septa?${params}`, { signal, cache: "no-store" });
  if (!r.ok) throw new Error(`SEPTA proxy ${r.status}`);
  return (await r.json()) as SeptaArrivalsResponse;
}

