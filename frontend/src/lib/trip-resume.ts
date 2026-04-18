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

const KEY = "pp:trip-resume-v1";
const TTL_MS = 2 * 60 * 60 * 1000; // 2h — past that the user has clearly moved on

export function saveTripSnapshot(snap: TripResumeSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    /* storage full / blocked — non-fatal */
  }
}

export function loadTripSnapshot(): TripResumeSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TripResumeSnapshot;
    if (!parsed || typeof parsed.startedAt !== "number") return null;
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
    const parsed = JSON.parse(raw) as TripResumeSnapshot;
    parsed.progress = progress;
    window.localStorage.setItem(KEY, JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
}
