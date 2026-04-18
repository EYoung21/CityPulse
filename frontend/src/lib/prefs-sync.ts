/** Per-account preference sync.
 *
 *  This module keeps a small, well-defined subset of `localStorage` in
 *  step with a single Firestore document per signed-in user, so that
 *  things like the user's theme, basemap choice, units, color-blind
 *  toggle, avoidance preferences, and POI overlay selections roam
 *  with them across devices and reinstalls.
 *
 *  Design constraints / decisions:
 *
 *   1. localStorage stays the source of truth for the running tab.
 *      All consumers continue to read from localStorage on mount —
 *      we don't touch that. Sync just mirrors what's already there.
 *
 *   2. We only sync a curated allow-list of keys (`SYNCED_PREF_KEYS`).
 *      Plenty of other localStorage entries are tab-local caches
 *      (PWA dismiss state, recent searches, alerts inbox, trip resume)
 *      that explicitly should not roam.
 *
 *   3. Per-tab change detection uses a custom `pp:pref-changed` event
 *      because the native `storage` event only fires *across* tabs,
 *      not inside the writing tab. Every callsite for a synced pref
 *      should use `setPref()` (which writes localStorage and dispatches)
 *      rather than calling `localStorage.setItem` directly.
 *
 *   4. On sign-in, we pull once from Firestore and — only if anything
 *      actually differs from the current local snapshot — overwrite
 *      localStorage and reload the tab. The reload is heavy-handed but
 *      lets every existing useState/initial-render-from-localStorage
 *      site pick up the new values without subscribing to anything.
 *      A reload happens at most once per sign-in per device.
 *
 *   5. Writes back to Firestore are debounced (1.5s) so toggling a
 *      cluster of POI overlays in quick succession lands as a single
 *      doc write, not seven.
 */

import { useEffect, useRef } from "react";
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";

/** Keys allowed to sync to Firestore. Anything else stays tab-local. */
export const SYNCED_PREF_KEYS = [
  "phlpulse-theme",
  "phlpulse-cb-palette",
  "pp:basemap",
  "pp:units",
  "pp:saved-places-overlay",
  "pp:nearby-poi-cats",
  "pp:avoid-prefs-v2",
  "pp:tod-overlay",
] as const;

export type SyncedPrefKey = typeof SYNCED_PREF_KEYS[number];

const SYNCED_SET = new Set<string>(SYNCED_PREF_KEYS);

/** Sentinel storing the last time we pulled from Firestore on this
 *  device. Used to skip the reload when local is already in sync. */
const LAST_PULLED_KEY = "pp:prefs-last-pulled-at";

/** Singleton in-flight write timer — kept module-scoped so simultaneous
 *  rapid toggles all coalesce, even across multiple hook instances. */
let pendingWriteTimer: number | null = null;

/** localStorage write that mirrors the value into the in-tab event
 *  channel so the prefs-sync hook (and any other future listeners)
 *  can react without polling. Falls back gracefully if storage is
 *  unavailable (private mode, quota errors). */
export function setPref(key: SyncedPrefKey, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked — best effort; we still dispatch so any listener
       can attempt to compensate. */
  }
  try {
    window.dispatchEvent(new CustomEvent("pp:pref-changed", { detail: { key, value } }));
  } catch { /* dispatch errors are non-fatal */ }
}

export function getPref(key: SyncedPrefKey): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

/** Snapshot every synced pref currently in localStorage. Missing keys
 *  are omitted (we don't want to overwrite a remote value with `null`
 *  just because the local user hasn't touched that pref yet). */
function snapshotLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof window === "undefined") return out;
  for (const k of SYNCED_PREF_KEYS) {
    try {
      const v = window.localStorage.getItem(k);
      if (v !== null) out[k] = v;
    } catch { /* ignore */ }
  }
  return out;
}

interface RemotePrefsDoc {
  values?: Record<string, unknown>;
  updatedAt?: { toMillis?: () => number } | number | null;
}

/** Strip non-string values from the remote doc so we never feed
 *  unexpected types into localStorage. */
function sanitizeRemote(values: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!values) return out;
  for (const [k, v] of Object.entries(values)) {
    if (!SYNCED_SET.has(k)) continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Compare two snapshots — returns true if any synced key differs. */
function snapshotsDiffer(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return true;
  }
  return false;
}

/** React hook that wires up the sync. Mount once near the auth root.
 *  No-op when Firebase is unconfigured or the user is anonymous. */
export function usePrefsSync(): void {
  const { user } = useAuth();
  const hydratedForUidRef = useRef<string | null>(null);

  // Pull-on-sign-in: if the remote doc differs from local, mirror
  // the remote values into localStorage and reload once so every
  // useState-from-localStorage callsite reads the fresh values.
  useEffect(() => {
    if (!user || user.isAnonymous || !isFirebaseConfigured()) return;
    if (hydratedForUidRef.current === user.uid) return;
    hydratedForUidRef.current = user.uid;

    void (async () => {
      try {
        const db = getFirestore(getFirebaseApp());
        const ref = doc(db, "users", user.uid, "userPrefs", "v1");
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          // First-time sign-in on this account: seed the doc with
          // whatever this device already has, so a second device
          // signing in immediately gets the same setup.
          const local = snapshotLocal();
          if (Object.keys(local).length > 0) {
            await setDoc(ref, { values: local, updatedAt: serverTimestamp() }, { merge: true });
          }
          if (typeof window !== "undefined") {
            try { window.localStorage.setItem(LAST_PULLED_KEY, String(Date.now())); } catch { /* */ }
          }
          return;
        }
        const data = snap.data() as RemotePrefsDoc;
        const remote = sanitizeRemote(data.values);
        const local = snapshotLocal();
        if (!snapshotsDiffer(local, remote)) return;

        // Mirror remote → local. We deliberately let remote win even
        // for keys that exist locally — explicit toggles after sign-in
        // will round-trip through Firestore in <2s and overwrite this.
        if (typeof window !== "undefined") {
          for (const k of SYNCED_PREF_KEYS) {
            try {
              if (Object.prototype.hasOwnProperty.call(remote, k)) {
                window.localStorage.setItem(k, remote[k]);
              }
            } catch { /* */ }
          }
          try { window.localStorage.setItem(LAST_PULLED_KEY, String(Date.now())); } catch { /* */ }
          // Soft reload — the only way to ensure every hook that
          // initialised from localStorage on mount picks up the
          // freshly-pulled values without subscribing to anything.
          window.location.reload();
        }
      } catch (err) {
        console.warn("[pp] prefs hydrate failed", err);
      }
    })();
  }, [user]);

  // Push-on-change: any synced pref written via setPref() is mirrored
  // back to Firestore on a debounce. We also batch any in-flight
  // changes that arrive during the debounce window into one write.
  useEffect(() => {
    if (!user || user.isAnonymous || !isFirebaseConfigured()) return;

    const handler = () => {
      if (pendingWriteTimer !== null) window.clearTimeout(pendingWriteTimer);
      pendingWriteTimer = window.setTimeout(() => {
        pendingWriteTimer = null;
        void (async () => {
          try {
            const db = getFirestore(getFirebaseApp());
            const ref = doc(db, "users", user.uid, "userPrefs", "v1");
            // Always send the full snapshot (not just the changed key)
            // so deletions / re-defaults round-trip cleanly. The doc
            // is < 1KB regardless of how many prefs the user has set.
            const values = snapshotLocal();
            await setDoc(ref, { values, updatedAt: serverTimestamp() }, { merge: true });
          } catch (err) {
            console.warn("[pp] prefs write failed", err);
          }
        })();
      }, 1500);
    };

    window.addEventListener("pp:pref-changed", handler as EventListener);
    return () => {
      window.removeEventListener("pp:pref-changed", handler as EventListener);
      if (pendingWriteTimer !== null) {
        window.clearTimeout(pendingWriteTimer);
        pendingWriteTimer = null;
      }
    };
  }, [user]);
}
