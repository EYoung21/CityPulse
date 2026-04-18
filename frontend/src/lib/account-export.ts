/** Account-level data export/import.
 *
 *  Bundles everything the user has put into the app on this device —
 *  saved places + lists, trip history, parked pin, alerts inbox,
 *  recent searches, and the synced prefs subset — into a single JSON
 *  blob the user can save locally. Imports do the reverse, with merge
 *  semantics on the per-collection level so an import doesn't blow
 *  away anything already on the destination device.
 *
 *  Why ship this at all:
 *    - GDPR/CCPA "data portability" obligation when we're holding
 *      Firestore data on signed-in users
 *    - Power users moving devices want a fallback in case Firestore
 *      sync glitches mid-migration
 *    - Demos / debugging — a known-good corpus to load into a clean
 *      browser
 *
 *  Trade-offs:
 *    - We export the *local* snapshot, not Firestore — that means if
 *      the user is signed-in and the local cache hasn't fully
 *      hydrated, the export may be incomplete. We accept this; the
 *      user can wait a few seconds for snapshots to settle, and the
 *      app already shows a loading spinner during that window.
 *    - Imports merge by primary key only (id for lists/destinations,
 *      lat/lng for parked pin and recents). True 3-way merges with
 *      timestamp arbitration would be safer but disproportionate to
 *      the use case (typically a one-shot device migration).
 */

import { getAlerts, type InboxAlert } from "@/lib/alerts-inbox";
import { getParkedPin, setParkedPin, type ParkedPin } from "@/lib/parked-pin";
import { loadRecent, pushRecent, type RecentSearch } from "@/lib/recent-searches";
import { getTripHistory, restoreTrip, type TripHistoryEntry } from "@/lib/trip-history";
import type { SavedDestination, SavedList } from "@/hooks/useSavedDestinations";

export const EXPORT_VERSION = 1;

export interface AccountExport {
  version: number;
  /** ISO timestamp of when this export was generated. */
  exportedAt: string;
  /** Display name + email at export time, for human reference only.
   *  Not used by import. */
  account?: { name?: string; email?: string };
  data: {
    savedDestinations?: SavedDestination[];
    savedLists?: SavedList[];
    tripHistory?: TripHistoryEntry[];
    alertsInbox?: InboxAlert[];
    recentSearches?: RecentSearch[];
    parkedPin?: ParkedPin | null;
    /** Synced preference keys → string values, mirroring the
     *  prefs-sync allow-list. */
    prefs?: Record<string, string>;
  };
}

/* --------- Export ---------------------------------------------- */

/** Build a snapshot of everything we can export from local state alone.
 *  Caller is responsible for supplying `savedDestinations` + `savedLists`
 *  since those live in the React-managed `useSavedDestinations` hook
 *  (Firestore subscription) rather than module-scoped storage. */
export function buildAccountExport(opts: {
  savedDestinations: SavedDestination[];
  savedLists: SavedList[];
  account?: { name?: string; email?: string };
}): AccountExport {
  const prefs: Record<string, string> = {};
  if (typeof window !== "undefined") {
    // Mirror the synced subset; importing on another device will
    // round-trip to Firestore via prefs-sync within ~1.5s after the
    // import writes them to localStorage.
    const KEYS = [
      "phlpulse-theme", "phlpulse-cb-palette", "pp:basemap", "pp:units",
      "pp:saved-places-overlay", "pp:nearby-poi-cats", "pp:avoid-prefs-v2",
      "pp:tod-overlay",
    ];
    for (const k of KEYS) {
      try {
        const v = window.localStorage.getItem(k);
        if (v !== null) prefs[k] = v;
      } catch { /* ignore */ }
    }
  }
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    account: opts.account,
    data: {
      savedDestinations: opts.savedDestinations,
      savedLists: opts.savedLists,
      tripHistory: getTripHistory(),
      alertsInbox: getAlerts(),
      recentSearches: loadRecent(),
      parkedPin: getParkedPin(),
      prefs,
    },
  };
}

/** Trigger a browser download of the export JSON. Filename includes
 *  date so multiple exports don't overwrite each other in Downloads. */
export function downloadAccountExport(exportObj: AccountExport): void {
  if (typeof window === "undefined") return;
  const json = JSON.stringify(exportObj, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `phillypulse-export-${dateStr}.json`;
  // Detached anchor — appended just long enough to trigger the click,
  // since some browsers require it in the DOM for the download to fire.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Drop the blob URL after a tick — click() is sync but Safari needs
  // the URL to remain valid through the resulting navigation event.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --------- Import ---------------------------------------------- */

export interface ImportResult {
  /** Per-collection counts of items merged in. */
  imported: {
    savedDestinations: number;
    savedLists: number;
    tripHistory: number;
    recentSearches: number;
    parkedPin: boolean;
    prefs: number;
  };
  /** Non-fatal warnings (unknown fields, version drift, etc). */
  warnings: string[];
}

/** Parse + validate a JSON blob. Throws with a user-friendly message
 *  for any structural problem; otherwise returns the typed object. */
export function parseAccountExport(raw: string): AccountExport {
  let obj: unknown;
  try { obj = JSON.parse(raw); }
  catch { throw new Error("File isn't valid JSON."); }
  if (typeof obj !== "object" || obj === null) {
    throw new Error("File doesn't look like a PhillyPulse export.");
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.version !== "number") {
    throw new Error("Missing version field — not a PhillyPulse export.");
  }
  if (o.version > EXPORT_VERSION) {
    throw new Error(
      `This export is from a newer version (${o.version}) than this app supports (${EXPORT_VERSION}). Update PhillyPulse and try again.`
    );
  }
  if (typeof o.data !== "object" || o.data === null) {
    throw new Error("Missing data section — file may be corrupt.");
  }
  return obj as AccountExport;
}

/** Apply an export to the current device's local stores. Saved
 *  places + lists go through the supplied async creators (Firestore
 *  paths) since we can't write user docs from this module directly. */
export async function applyAccountImport(
  exp: AccountExport,
  hooks: {
    /** Called per saved-list to recreate. Should return the new list
     *  ID so we can re-link member destinations. May skip if a
     *  same-named list already exists (then return the existing id). */
    upsertList: (list: SavedList) => Promise<string | null>;
    /** Called per saved-destination to recreate, with the `listId`
     *  remapped to whatever upsertList returned for the original
     *  list (or null if it wasn't found / wasn't a custom). */
    upsertDestination: (
      dest: SavedDestination,
      remappedListId: string | null
    ) => Promise<void>;
  }
): Promise<ImportResult> {
  const warnings: string[] = [];
  const result: ImportResult = {
    imported: {
      savedDestinations: 0,
      savedLists: 0,
      tripHistory: 0,
      recentSearches: 0,
      parkedPin: false,
      prefs: 0,
    },
    warnings,
  };

  // Saved lists first so we can build an oldId → newId map for the
  // destinations pass.
  const listIdMap = new Map<string, string | null>();
  for (const list of exp.data.savedLists ?? []) {
    try {
      const newId = await hooks.upsertList(list);
      listIdMap.set(list.id, newId);
      if (newId) result.imported.savedLists++;
    } catch (err) {
      warnings.push(`Failed to import list "${list.name}": ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  for (const dest of exp.data.savedDestinations ?? []) {
    try {
      const remapped = dest.listId ? (listIdMap.get(dest.listId) ?? null) : null;
      await hooks.upsertDestination(dest, remapped);
      result.imported.savedDestinations++;
    } catch (err) {
      warnings.push(`Failed to import "${dest.name}": ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  // Trip history — restoreTrip dedupes by id and re-sorts chronologically.
  for (const entry of exp.data.tripHistory ?? []) {
    try {
      restoreTrip(entry);
      result.imported.tripHistory++;
    } catch { /* skip silently — bad entry */ }
  }

  // Recents are append-with-dedupe. Push oldest first so the most
  // recent entries from the export end up at the top.
  const recentsToImport = [...(exp.data.recentSearches ?? [])].sort((a, b) => a.at - b.at);
  for (const r of recentsToImport) {
    try {
      pushRecent({ display_name: r.display_name, lat: r.lat, lng: r.lng });
      result.imported.recentSearches++;
    } catch { /* ignore */ }
  }

  if (exp.data.parkedPin) {
    try {
      setParkedPin({
        lat: exp.data.parkedPin.lat,
        lng: exp.data.parkedPin.lng,
        label: exp.data.parkedPin.label,
        note: exp.data.parkedPin.note,
      });
      result.imported.parkedPin = true;
    } catch { /* ignore */ }
  }

  // Prefs: write directly to localStorage and dispatch the change
  // event so prefs-sync flushes them to Firestore on the next debounce.
  if (exp.data.prefs && typeof window !== "undefined") {
    for (const [k, v] of Object.entries(exp.data.prefs)) {
      try {
        window.localStorage.setItem(k, v);
        window.dispatchEvent(new CustomEvent("pp:pref-changed", { detail: { key: k, value: v } }));
        result.imported.prefs++;
      } catch { /* ignore */ }
    }
  }

  return result;
}
