/** localStorage-backed ring of the user's recent geocoded picks. Used by the
 *  search box to suggest previous destinations on focus and by the Saved
 *  Places shelf as a "recently visited" hint. */

export interface RecentSearch {
  display_name: string;
  lat: number;
  lng: number;
  /** ms epoch — newer = first */
  at: number;
}

const KEY = "pp:recent-searches";
const MAX = 8;

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
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    /* storage full or denied */
  }
  return merged;
}

export function clearRecent(): void {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
