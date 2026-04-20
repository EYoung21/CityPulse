/** localStorage-backed log of completed trips. Persisted across
 *  refreshes so users can see "what they did last week" without us
 *  needing a backend. Capped at 50 entries with a 60-day TTL — enough
 *  to be useful, small enough to stay under the 5 MB localStorage
 *  budget even with chatty users.
 *
 *  Each entry stores the inputs needed to replay the trip via the
 *  existing `pp:resume-trip` event, plus optional rating/notes from
 *  TripRecapCard. Geometry is not stored (potentially many KB) — the
 *  recipient screen would re-fetch via the same routing call. */

const KEY = "pp:trip-history-v1";
const MAX_ENTRIES = 50;
const TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export interface TripHistoryEntry {
  id: string;
  startedAt: number;
  endedAt: number;
  /** km traveled (lower of planned vs progress * planned). */
  traveledKm: number;
  /** km planned. Helps surface "you only completed 60% of this trip". */
  totalDistanceKm: number;
  mode: string;
  /** Optional human-readable origin/destination labels. Either may be
   *  empty for legacy entries pre-dating the input plumbing. */
  origin?: { display_name: string; lat: number; lng: number };
  dest?: { display_name: string; lat: number; lng: number };
  nearbyIncidents: number;
  wasSafeRoute: boolean;
  /** True if the user reached >= 95% of the route. */
  completed: boolean;
  /** Optional 1..5 star rating set by the user from the recap card. */
  rating?: number;
  /** Optional freeform notes set by the user from the recap card. */
  notes?: string;
  /** Decimated route polyline captured at trip start. Optional because
   *  pre-existing entries (recorded before this field was added) and
   *  trips where geometry was unavailable simply omit it. Stored as
   *  `[lat, lng]` pairs — same shape as everywhere else in the app —
   *  and decimated to ~120 points to stay under the per-entry size
   *  budget while still tracing the route well enough for a GPX
   *  export to look right when imported into Strava / Garmin. */
  geometry?: [number, number][];
}

type Listener = (entries: TripHistoryEntry[]) => void;
const listeners = new Set<Listener>();

function read(): TripHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TripHistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - TTL_MS;
    return parsed.filter((e) => e && typeof e.startedAt === "number" && e.startedAt >= cutoff);
  } catch {
    return [];
  }
}

function write(entries: TripHistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage full — best effort */
  }
  for (const fn of listeners) {
    try { fn(entries); } catch { /* ignore single bad subscriber */ }
  }
}

export function getTripHistory(): TripHistoryEntry[] {
  return read();
}

export function recordTrip(entry: Omit<TripHistoryEntry, "id">): TripHistoryEntry {
  const id = `${entry.startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const full: TripHistoryEntry = { ...entry, id };
  const existing = read();
  existing.unshift(full);
  write(existing);
  return full;
}

/** Update rating/notes on an already-recorded trip. Used by the recap
 *  card so star/comment changes flow through to history without
 *  requiring a re-record. */
export function updateTrip(id: string, patch: Partial<Pick<TripHistoryEntry, "rating" | "notes">>): void {
  const next = read().map((e) => (e.id === id ? { ...e, ...patch } : e));
  write(next);
}

export function deleteTrip(id: string): void {
  write(read().filter((e) => e.id !== id));
}

/** Restore a previously-deleted trip back into history. Used by the
 *  undo-toast flow: callers snapshot the entry before deletion, then
 *  pass it to this function if the user taps Undo. Slots the entry
 *  back in chronological order rather than at the top, since that
 *  matches where the user expects to see it. */
export function restoreTrip(entry: TripHistoryEntry): void {
  const existing = read();
  // Skip if the same id is somehow already present (double-undo race).
  if (existing.some((e) => e.id === entry.id)) return;
  const next = [...existing, entry].sort((a, b) => b.startedAt - a.startedAt);
  write(next);
}

export function clearTripHistory(): void {
  write([]);
}

export function subscribeTripHistory(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
