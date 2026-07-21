"use client";

import { readBoundedJsonResponse } from "@/lib/upstream-response";

/** BART (Bay Area Rapid Transit) real-time helpers.
 *
 *  BART's "etd" (Estimated Time of Departure) endpoint is unauthen-
 *  ticated in practice — the public demo key MW9S-E7SL-26DU-VV8V has
 *  been stable since ~2010 and the operators do not throttle it
 *  separately. We still proxy through /api/bart for the same reasons
 *  we proxy SEPTA: a single User-Agent, server-side cache, and the
 *  option to swap a real key in later without touching the client.
 *
 *  BART runs ~5 AM → midnight; queries during the shut-down window
 *  return a friendly "Updates are temporarily unavailable" message
 *  from upstream, which we surface as zero arrivals rather than an
 *  error (the UI then says "No upcoming departures" — correct). */

export interface BartStation {
  /** 4-letter API code (POWL, EMBR, …) passed to the etd endpoint. */
  code: string;
  /** Human display name from BART's stn endpoint. */
  name: string;
  lat: number;
  lng: number;
}

/** All 50 BART stations, generated from BART's /api/stn.aspx response
 *  on 2026-05-17. Stable enough to hardcode — BART adds maybe one new
 *  station every few years. */
export const BART_STATIONS: readonly BartStation[] = [
  { code: "12TH", name: "12th St. Oakland City Center", lat: 37.80377, lng: -122.27145 },
  { code: "16TH", name: "16th St. Mission", lat: 37.76506, lng: -122.41969 },
  { code: "19TH", name: "19th St. Oakland", lat: 37.80835, lng: -122.26860 },
  { code: "24TH", name: "24th St. Mission", lat: 37.75247, lng: -122.41814 },
  { code: "ANTC", name: "Antioch", lat: 37.99539, lng: -121.78042 },
  { code: "ASHB", name: "Ashby", lat: 37.85280, lng: -122.27006 },
  { code: "BALB", name: "Balboa Park", lat: 37.72158, lng: -122.44751 },
  { code: "BAYF", name: "Bay Fair", lat: 37.69692, lng: -122.12651 },
  { code: "BERY", name: "Berryessa/North San Jose", lat: 37.36847, lng: -121.87468 },
  { code: "CAST", name: "Castro Valley", lat: 37.69075, lng: -122.07560 },
  { code: "CIVC", name: "Civic Center/UN Plaza", lat: 37.77973, lng: -122.41412 },
  { code: "COLS", name: "Coliseum", lat: 37.75366, lng: -122.19687 },
  { code: "COLM", name: "Colma", lat: 37.68464, lng: -122.46623 },
  { code: "CONC", name: "Concord", lat: 37.97374, lng: -122.02909 },
  { code: "DALY", name: "Daly City", lat: 37.70612, lng: -122.46908 },
  { code: "DBRK", name: "Downtown Berkeley", lat: 37.87010, lng: -122.26813 },
  { code: "DUBL", name: "Dublin/Pleasanton", lat: 37.70169, lng: -121.89918 },
  { code: "DELN", name: "El Cerrito del Norte", lat: 37.92509, lng: -122.31679 },
  { code: "PLZA", name: "El Cerrito Plaza", lat: 37.90263, lng: -122.29890 },
  { code: "EMBR", name: "Embarcadero", lat: 37.79287, lng: -122.39702 },
  { code: "FRMT", name: "Fremont", lat: 37.55747, lng: -121.97661 },
  { code: "FTVL", name: "Fruitvale", lat: 37.77484, lng: -122.22418 },
  { code: "GLEN", name: "Glen Park", lat: 37.73306, lng: -122.43382 },
  { code: "HAYW", name: "Hayward", lat: 37.66972, lng: -122.08702 },
  { code: "LAFY", name: "Lafayette", lat: 37.89318, lng: -122.12463 },
  { code: "LAKE", name: "Lake Merritt", lat: 37.79703, lng: -122.26518 },
  { code: "MCAR", name: "MacArthur", lat: 37.82906, lng: -122.26704 },
  { code: "MLBR", name: "Millbrae", lat: 37.60027, lng: -122.38670 },
  { code: "MLPT", name: "Milpitas", lat: 37.41028, lng: -121.89108 },
  { code: "MONT", name: "Montgomery St.", lat: 37.78941, lng: -122.40107 },
  { code: "NBRK", name: "North Berkeley", lat: 37.87397, lng: -122.28344 },
  { code: "NCON", name: "North Concord/Martinez", lat: 38.00319, lng: -122.02465 },
  { code: "OAKL", name: "Oakland International Airport", lat: 37.71324, lng: -122.21219 },
  { code: "ORIN", name: "Orinda", lat: 37.87836, lng: -122.18379 },
  { code: "PITT", name: "Pittsburg/Bay Point", lat: 38.01891, lng: -121.94515 },
  { code: "PCTR", name: "Pittsburg Center", lat: 38.01694, lng: -121.88946 },
  { code: "PHIL", name: "Pleasant Hill/Contra Costa Centre", lat: 37.92847, lng: -122.05601 },
  { code: "POWL", name: "Powell St.", lat: 37.78447, lng: -122.40797 },
  { code: "RICH", name: "Richmond", lat: 37.93685, lng: -122.35310 },
  { code: "ROCK", name: "Rockridge", lat: 37.84470, lng: -122.25137 },
  { code: "SBRN", name: "San Bruno", lat: 37.63776, lng: -122.41629 },
  { code: "SFIA", name: "San Francisco International Airport", lat: 37.61597, lng: -122.39241 },
  { code: "SANL", name: "San Leandro", lat: 37.72195, lng: -122.16084 },
  { code: "SHAY", name: "South Hayward", lat: 37.63437, lng: -122.05719 },
  { code: "SSAN", name: "South San Francisco", lat: 37.66425, lng: -122.44396 },
  { code: "UCTY", name: "Union City", lat: 37.59063, lng: -122.01739 },
  { code: "WCRK", name: "Walnut Creek", lat: 37.90552, lng: -122.06753 },
  { code: "WARM", name: "Warm Springs/South Fremont", lat: 37.50217, lng: -121.93931 },
  { code: "WDUB", name: "West Dublin/Pleasanton", lat: 37.69976, lng: -121.92824 },
  { code: "WOAK", name: "West Oakland", lat: 37.80487, lng: -122.29514 },
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

export interface BartStationWithDistance {
  station: BartStation;
  km: number;
}

export function nearestBartStation(
  lat: number,
  lng: number,
  maxKm = 5
): BartStationWithDistance | null {
  let best: BartStationWithDistance | null = null;
  for (const s of BART_STATIONS) {
    const km = haversineKm(lat, lng, s.lat, s.lng);
    if (km > maxKm) continue;
    if (!best || km < best.km) best = { station: s, km };
  }
  return best;
}

/** One upcoming train as we surface it to the user. Already
 *  normalized — BART's raw shape has departures nested per-destination
 *  per-platform and is too complex to render directly. */
export interface BartArrival {
  destination: string;
  /** Minutes until departure (`"Leaving"` for <1 min). */
  minutes: string;
  /** Line color in BART's published palette. */
  color: string;
  /** Platform number, when given. */
  platform?: string;
}

export interface BartArrivalsResponse {
  station_name: string;
  /** Upstream "HH:MM:SS XM" string, useful for showing freshness. */
  fetched_label: string;
  arrivals: BartArrival[];
}

function cleanBartText(value: unknown, maxLength = 200): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function normalizeBartArrivalsResponse(value: unknown): BartArrivalsResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const arrivals = Array.isArray(data.arrivals)
    ? data.arrivals.slice(0, 100).flatMap((value): BartArrival[] => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const row = value as Record<string, unknown>;
        const destination = cleanBartText(row.destination);
        const minutes = cleanBartText(row.minutes, 20);
        if (!destination || !minutes) return [];
        const color = cleanBartText(row.color, 16);
        const platform = cleanBartText(row.platform, 20);
        return [{
          destination,
          minutes,
          color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#888888",
          ...(platform ? { platform } : {}),
        }];
      })
    : [];
  return {
    station_name: cleanBartText(data.station_name),
    fetched_label: cleanBartText(data.fetched_label, 100),
    arrivals,
  };
}

/** Fetch arrivals for a BART station via our /api/bart proxy. */
export async function fetchBartArrivals(
  code: string,
  signal?: AbortSignal
): Promise<BartArrivalsResponse> {
  const params = new URLSearchParams({ op: "etd", station: code });
  const r = await fetch(`/api/bart?${params}`, { signal, cache: "no-store" });
  if (!r.ok) throw new Error(`BART proxy ${r.status}`);
  const data = normalizeBartArrivalsResponse(await readBoundedJsonResponse(r, 1024 * 1024));
  if (!data) throw new Error("BART proxy returned a malformed response");
  return data;
}
