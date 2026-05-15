import type { Incident } from "@/lib/api";

const KEY_PREFIX = "pp:incidents:v1:";
/** Show cached pins up to this age while a fresh fetch runs. */
const MAX_AGE_MS = 45 * 60 * 1000;
const MAX_ROWS = 600;

interface CacheEntry {
  savedAt: number;
  city: string;
  incidents: Incident[];
}

function cacheKey(city: string): string {
  return `${KEY_PREFIX}${city}`;
}

/** Last-known incident slice for a city — used for instant paint on reload. */
export function loadCachedIncidents(city: string): { incidents: Incident[]; savedAt: number } | null {
  if (typeof window === "undefined" || !city) return null;
  try {
    const raw = localStorage.getItem(cacheKey(city));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || entry.city !== city || !Array.isArray(entry.incidents)) return null;
    if (Date.now() - entry.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(cacheKey(city));
      return null;
    }
    return { incidents: entry.incidents.slice(0, MAX_ROWS), savedAt: entry.savedAt };
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: { city: string; incidents: Incident[] } | null = null;

/** Debounced write so live Firestore snapshots don't hammer localStorage. */
export function saveCachedIncidents(city: string, incidents: Incident[]): void {
  if (typeof window === "undefined" || !city || incidents.length === 0) return;
  pendingSave = { city, incidents: incidents.slice(0, MAX_ROWS) };
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload = pendingSave;
    pendingSave = null;
    if (!payload) return;
    try {
      const entry: CacheEntry = {
        savedAt: Date.now(),
        city: payload.city,
        incidents: payload.incidents,
      };
      localStorage.setItem(cacheKey(payload.city), JSON.stringify(entry));
    } catch {
      /* quota — non-fatal */
    }
  }, 400);
}
