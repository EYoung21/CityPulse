/** localStorage-backed ring of the user's recent geocoded picks. Used by the
 *  search box to suggest previous destinations on focus and by the Saved
 *  Places shelf as a "recently visited" hint.
 *
 *  Routed through prefs-sync (`pp:recent-searches` is on the allow-list)
 *  so a destination searched on phone shows up at the top of the list
 *  on desktop within a couple of seconds of signing in. */

import { setPref } from "./prefs-sync";

export interface RecentSearch {
  display_name: string;
  lat: number;
  lng: number;
  /** ms epoch — newer = first */
  at: number;
}

const KEY = "pp:recent-searches";
const MAX = 12;

type Listener = (entries: RecentSearch[]) => void;
const listeners = new Set<Listener>();

function emit(entries: RecentSearch[]): void {
  for (const fn of listeners) {
    try { fn(entries); } catch { /* ignore single bad subscriber */ }
  }
}

export function loadRecent(): RecentSearch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (r): r is RecentSearch =>
        r &&
        typeof r.display_name === "string" &&
        typeof r.lat === "number" &&
        typeof r.lng === "number"
    );
  } catch {
    return [];
  }
}

/** Prepend `entry`, dedupe by lat/lng (≈11m), cap to MAX. */
export function pushRecent(entry: Omit<RecentSearch, "at">): RecentSearch[] {
  if (typeof window === "undefined") return [];
  const next: RecentSearch = { ...entry, at: Date.now() };
  const existing = loadRecent().filter(
    (r) =>
      Math.abs(r.lat - next.lat) > 1e-4 || Math.abs(r.lng - next.lng) > 1e-4
  );
  const merged = [next, ...existing].slice(0, MAX);
  try {
    setPref("pp:recent-searches", JSON.stringify(merged));
  } catch {
    /* storage full or denied */
  }
  emit(merged);
  return merged;
}

/** Remove a single recent by lat/lng identity — useful for an "X" affordance
 *  on each row when the user wants to forget *one* destination without
 *  nuking the whole history. */
export function removeRecent(lat: number, lng: number): RecentSearch[] {
  if (typeof window === "undefined") return [];
  const filtered = loadRecent().filter(
    (r) => Math.abs(r.lat - lat) > 1e-4 || Math.abs(r.lng - lng) > 1e-4
  );
  try {
    setPref("pp:recent-searches", JSON.stringify(filtered));
  } catch { /* ignore */ }
  emit(filtered);
  return filtered;
}

export function clearRecent(): void {
  if (typeof window === "undefined") return;
  try { setPref("pp:recent-searches", "[]"); } catch { /* ignore */ }
  emit([]);
}

/** Subscribe to recent-search changes — fires on every push/remove/clear,
 *  including changes that originated from prefs-sync hydration in another
 *  tab (via the storage event we still get from non-`setPref` paths). */
export function subscribeRecent(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Cross-tab sync: when prefs-sync hydrates from Firestore on sign-in,
// the new value lands via localStorage.setItem and dispatches a storage
// event in the *other* tabs. Mirror that into our pubsub.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) emit(loadRecent());
  });
}
