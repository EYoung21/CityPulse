import type { LiveTripDoc } from "@/lib/live-share";
import { isCoordinatePair } from "@/lib/geo-validation";

const LIVE_SHARE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const LIVE_MODES = new Set([
  "foot-walking",
  "cycling-regular",
  "driving-car",
  "wheelchair",
  "transit-train",
  "transit-subway",
]);

export function isLiveShareId(value: unknown): value is string {
  return typeof value === "string" && LIVE_SHARE_ID_RE.test(value);
}

export function liveShareExpiryMillis(value: unknown): number | null {
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  if (value && typeof value === "object") {
    const toMillis = (value as { toMillis?: unknown }).toMillis;
    if (typeof toMillis === "function") {
      try {
        const millis = toMillis.call(value);
        return typeof millis === "number" && Number.isFinite(millis) ? millis : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Validate public Firestore data before handing it to Leaflet/date formatters. */
export function parseLiveTripDoc(value: unknown): LiveTripDoc | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const position = data.position as Record<string, unknown> | null;
  const dest = data.dest as Record<string, unknown> | null;
  if (!position || !dest) return null;
  if (!isCoordinatePair([position.lat, position.lng])) return null;
  if (!isCoordinatePair([dest.lat, dest.lng])) return null;
  if (typeof dest.name !== "string" || !dest.name.trim() || dest.name.length > 120) return null;
  if (typeof data.ownerUid !== "string" || !data.ownerUid || data.ownerUid.length > 128) return null;
  if (
    data.ownerName !== null &&
    data.ownerName !== undefined &&
    (typeof data.ownerName !== "string" || data.ownerName.length > 80)
  ) return null;
  if (typeof data.progressPct !== "number" || !Number.isFinite(data.progressPct) || data.progressPct < 0 || data.progressPct > 1) return null;
  if (typeof data.mode !== "string" || !LIVE_MODES.has(data.mode)) return null;
  if (typeof data.ended !== "boolean") return null;
  if (data.etaAt !== null && (typeof data.etaAt !== "number" || !Number.isFinite(data.etaAt))) return null;
  if (
    position.heading !== null &&
    (typeof position.heading !== "number" ||
      !Number.isFinite(position.heading) ||
      position.heading < 0 ||
      position.heading > 360)
  ) return null;
  if (liveShareExpiryMillis(data.expiresAt) === null) return null;

  return data as unknown as LiveTripDoc;
}
