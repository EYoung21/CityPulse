/** localStorage-backed snapshot of an in-progress trip so a refresh /
 *  navigation away and back doesn't dump the user out of nav.
 *
 *  The snapshot is intentionally minimal — we don't store the full
 *  route geometry (potentially many KB), only the inputs needed to
 *  reconstitute the trip via the same `startTrip()` codepath. The
 *  recipient screen prompts the user before resuming so we never
 *  silently auto-start nav on a returning visit. */

export interface TripResumeSnapshot {
  origin: { display_name: string; lat: number; lng: number };
  dest: { display_name: string; lat: number; lng: number };
  stops: { id: string; query: string; loc: { display_name: string; lat: number; lng: number } | null }[];
  mode: string;
  startedAt: number;
  /** Most recently observed progress 0..1 — used to skip the resume
   *  prompt when the trip was effectively complete. */
  progress: number;
}

import { isCoordinatePair } from "@/lib/geo-validation";

const KEY = "pp:trip-resume-v1";
const TTL_MS = 2 * 60 * 60 * 1000; // 2h — past that the user has clearly moved on

function parseLocation(value: unknown): TripResumeSnapshot["origin"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const coordinates = [row.lat, row.lng];
  if (typeof row.display_name !== "string" || !isCoordinatePair(coordinates)) return null;
  return {
    display_name: row.display_name.slice(0, 1_000),
    lat: coordinates[0],
    lng: coordinates[1],
  };
}

function parseSnapshot(value: unknown): TripResumeSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const origin = parseLocation(row.origin);
  const dest = parseLocation(row.dest);
  if (
    !origin ||
    !dest ||
    typeof row.mode !== "string" ||
    !row.mode.trim() ||
    typeof row.startedAt !== "number" ||
    !Number.isFinite(row.startedAt) ||
    row.startedAt <= 0 ||
    row.startedAt > Date.now() + 5 * 60_000
  ) {
    return null;
  }
  const stops = Array.isArray(row.stops)
    ? row.stops.slice(0, 10).flatMap((value): TripResumeSnapshot["stops"] => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const stop = value as Record<string, unknown>;
        if (typeof stop.id !== "string" || typeof stop.query !== "string") return [];
        const loc = stop.loc === null ? null : parseLocation(stop.loc);
        if (stop.loc !== null && !loc) return [];
        return [{ id: stop.id.slice(0, 200), query: stop.query.slice(0, 1_000), loc }];
      })
    : [];
  const progress = typeof row.progress === "number" && Number.isFinite(row.progress)
    ? Math.max(0, Math.min(1, row.progress))
    : 0;
  return {
    origin,
    dest,
    stops,
    mode: row.mode.slice(0, 100),
    startedAt: row.startedAt,
    progress,
  };
}

export function saveTripSnapshot(snap: TripResumeSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    const clean = parseSnapshot(snap);
    if (clean) window.localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    /* storage full / blocked — non-fatal */
  }
}

export function loadTripSnapshot(): TripResumeSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = parseSnapshot(JSON.parse(raw));
    if (!parsed) {
      clearTripSnapshot();
      return null;
    }
    if (Date.now() - parsed.startedAt > TTL_MS) {
      // Snapshot is stale — clean up so we don't spam the prompt
      // every page load.
      clearTripSnapshot();
      return null;
    }
    if ((parsed.progress ?? 0) >= 0.95) {
      // Already arrived; nothing to resume.
      clearTripSnapshot();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearTripSnapshot(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Update only the `progress` field on an existing snapshot, skipping
 *  the write entirely if there's nothing stored. Called from the trip
 *  HUD as the user travels so a mid-trip refresh restores at the
 *  correct point. */
export function updateTripProgress(progress: number): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = parseSnapshot(JSON.parse(raw));
    if (!parsed) {
      clearTripSnapshot();
      return;
    }
    parsed.progress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : parsed.progress;
    window.localStorage.setItem(KEY, JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
}
