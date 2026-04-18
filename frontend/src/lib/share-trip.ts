/** Backend-free "share my live ETA" token.
 *
 *  Encodes a snapshot of the current trip (destination, route geometry,
 *  estimated time of arrival, transport mode, and an optional sender
 *  name) into a compact base64url string that fits inside a URL hash.
 *  The recipient's app decodes the token client-side and renders a
 *  read-only tracking card that ticks down ETA from `now()`.
 *
 *  Trade-offs vs. a live backend tracker:
 *    + no infrastructure / cost / accounts required
 *    + privacy: nothing leaves the sender's device beyond the link itself
 *    - the route is a one-shot snapshot, not real-time GPS
 *    - tokens are publicly decodable by anyone with the link
 *
 *  Token format (after base64url decode):
 *    {
 *      v: 1,                     // schema version
 *      n?: string,               // sender name
 *      d: [lat, lng],            // destination
 *      m: TransportMode,         // transit mode
 *      eta: number,              // ms epoch
 *      sentAt: number,           // ms epoch
 *      g: string,                // Google encoded polyline (geometry)
 *    }
 */

import type { TransportMode } from "./routing";

export const TRIP_TOKEN_VERSION = 1;

export interface TripShareSnapshot {
  /** Optional friendly name for the sender, shown in the recipient view. */
  name?: string;
  destination: [number, number];
  mode: TransportMode;
  /** Estimated time of arrival, ms epoch. */
  etaEpochMs: number;
  /** When the snapshot was generated, ms epoch. */
  sentAtEpochMs: number;
  /** Polyline as `[lat, lng]` pairs in route order. Will be simplified to
   *  ~200 points before encoding to keep tokens under URL size limits. */
  geometry: [number, number][];
}

/* --------- Google encoded polyline (precision 5) ---------------------- */

function encodeSignedNumber(num: number): string {
  let sgn = num << 1;
  if (num < 0) sgn = ~sgn;
  let result = "";
  while (sgn >= 0x20) {
    result += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  result += String.fromCharCode(sgn + 63);
  return result;
}

export function encodePolyline(points: [number, number][]): string {
  let prevLat = 0;
  let prevLng = 0;
  let out = "";
  for (const [lat, lng] of points) {
    const lat5 = Math.round(lat * 1e5);
    const lng5 = Math.round(lng * 1e5);
    out += encodeSignedNumber(lat5 - prevLat);
    out += encodeSignedNumber(lng5 - prevLng);
    prevLat = lat5;
    prevLng = lng5;
  }
  return out;
}

export function decodePolyline(str: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dLat = (result & 1) ? ~(result >> 1) : result >> 1;
    lat += dLat;

    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dLng = (result & 1) ? ~(result >> 1) : result >> 1;
    lng += dLng;

    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

/* --------- Geometry simplification (Ramer-Douglas-Peucker) ----------- */

function perpDistanceMeters(p: [number, number], a: [number, number], b: [number, number]): number {
  // Tiny equirectangular projection — accurate enough at city scale and
  // avoids dragging in turf.js or proj4 just for this.
  const lat = (a[0] + b[0]) * 0.5 * (Math.PI / 180);
  const cosLat = Math.cos(lat);
  const ax = a[1] * cosLat, ay = a[0];
  const bx = b[1] * cosLat, by = b[0];
  const px = p[1] * cosLat, py = p[0];
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay) * 111320;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.hypot(px - projX, py - projY) * 111320;
}

function rdpSimplify(points: [number, number][], toleranceM: number): [number, number][] {
  if (points.length < 3) return points.slice();
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistanceMeters(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > toleranceM) {
    const left  = rdpSimplify(points.slice(0, index + 1), toleranceM);
    const right = rdpSimplify(points.slice(index), toleranceM);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

/** Iteratively simplify a polyline until it has at most `maxPoints`. */
function simplifyToBudget(points: [number, number][], maxPoints: number): [number, number][] {
  if (points.length <= maxPoints) return points;
  let tolerance = 5;
  let simplified = rdpSimplify(points, tolerance);
  let safety = 0;
  while (simplified.length > maxPoints && safety < 12) {
    tolerance *= 1.6;
    simplified = rdpSimplify(points, tolerance);
    safety++;
  }
  return simplified;
}

/* --------- Base64url helpers (URL-safe, no padding) ------------------ */

function base64UrlEncode(s: string): string {
  if (typeof window === "undefined") {
    return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  if (typeof window === "undefined") return Buffer.from(padded, "base64").toString("utf8");
  return atob(padded);
}

/* --------- Public API ------------------------------------------------ */

export interface DecodedTripToken extends TripShareSnapshot {
  version: number;
}

/** Pack a TripShareSnapshot into a URL-safe token. The geometry is
 *  simplified to ~200 points before encoding. */
export function encodeTripToken(snap: TripShareSnapshot): string {
  const geom = simplifyToBudget(snap.geometry, 200);
  const payload = {
    v:      TRIP_TOKEN_VERSION,
    n:      snap.name?.slice(0, 32) || undefined,
    d:      [Number(snap.destination[0].toFixed(5)), Number(snap.destination[1].toFixed(5))],
    m:      snap.mode,
    eta:    Math.round(snap.etaEpochMs),
    sentAt: Math.round(snap.sentAtEpochMs),
    g:      encodePolyline(geom),
  };
  return base64UrlEncode(JSON.stringify(payload));
}

interface RawPayload {
  v?: unknown;
  n?: unknown;
  d?: unknown;
  m?: unknown;
  eta?: unknown;
  sentAt?: unknown;
  g?: unknown;
}

/** Inverse of `encodeTripToken`. Returns `null` if the token is
 *  unparseable / from a future version / missing required fields. */
export function decodeTripToken(token: string): DecodedTripToken | null {
  try {
    const json = base64UrlDecode(token);
    const obj = JSON.parse(json) as RawPayload;
    if (obj.v !== TRIP_TOKEN_VERSION) return null;
    if (!Array.isArray(obj.d) || obj.d.length !== 2) return null;
    if (typeof obj.eta !== "number" || typeof obj.sentAt !== "number") return null;
    if (typeof obj.g !== "string") return null;
    if (typeof obj.m !== "string") return null;
    const geometry = decodePolyline(obj.g);
    const dLat = Number(obj.d[0]);
    const dLng = Number(obj.d[1]);
    if (!Number.isFinite(dLat) || !Number.isFinite(dLng)) return null;
    return {
      version: obj.v,
      name: typeof obj.n === "string" ? obj.n : undefined,
      destination: [dLat, dLng],
      mode: obj.m as TransportMode,
      etaEpochMs: obj.eta,
      sentAtEpochMs: obj.sentAt,
      geometry,
    };
  } catch {
    return null;
  }
}

/** Build a shareable URL pointing at the unfurl-friendly /share/trip page,
 *  which renders rich OG metadata and bounces the recipient into the main
 *  app at `/?trip=<token>`. */
export function buildTripShareUrl(snap: TripShareSnapshot, base?: string): string {
  const token = encodeTripToken(snap);
  const origin = base || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}/share/trip?t=${token}`;
}
