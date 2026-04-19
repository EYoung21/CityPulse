"use client";

/** Per-category alert mutes.
 *
 *  The user can opt out of being interrupted by individual incident
 *  categories — e.g. someone who lives next to a busy hospital might
 *  want to silence "Medical" alerts, or a downtown commuter might
 *  not care about parking-violation noise.
 *
 *  What it gates:
 *    - `recordAlert` skips writing inbox entries whose category is
 *      muted (so the bell doesn't pile up irrelevant rows).
 *    - The off-screen / on-route alert chips check the mute set
 *      before surfacing.
 *    - Push notifications skip muted categories.
 *
 *  What it does NOT gate:
 *    - Map markers and the heatmap. Mute is about *interruption*, not
 *      visibility — the user can still see the incident if they
 *      explicitly look at the map.
 *    - Alerts the user explicitly opens (e.g. tapping an inbox row).
 *
 *  Shape:
 *    Backed by a single localStorage key holding a sorted array of
 *    severity-category slugs. Synced via prefs-sync so a user's mute
 *    list roams across devices. */

import { setPref } from "@/lib/prefs-sync";

const KEY = "pp:muted-categories";

type Listener = (muted: Set<string>) => void;
const listeners = new Set<Listener>();

function emit(next: Set<string>): void {
  for (const fn of listeners) {
    try { fn(next); } catch { /* ignore single bad subscriber */ }
  }
}

export function loadMutedCategories(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((s): s is string => typeof s === "string"));
  } catch {
    return new Set();
  }
}

function persist(next: Set<string>): void {
  try {
    // Sort so the JSON payload is stable → fewer no-op writes to
    // Firestore through prefs-sync, and easier diffing in devtools.
    setPref(KEY, JSON.stringify([...next].sort()));
  } catch {
    /* storage full / blocked — non-fatal */
  }
  emit(next);
}

export function isCategoryMuted(category: string | null | undefined): boolean {
  if (!category) return false;
  return loadMutedCategories().has(category);
}

export function muteCategory(category: string): void {
  const next = loadMutedCategories();
  if (next.has(category)) return;
  next.add(category);
  persist(next);
}

export function unmuteCategory(category: string): void {
  const next = loadMutedCategories();
  if (!next.delete(category)) return;
  persist(next);
}

export function toggleCategoryMute(category: string): boolean {
  const next = loadMutedCategories();
  if (next.has(category)) {
    next.delete(category);
    persist(next);
    return false;
  }
  next.add(category);
  persist(next);
  return true;
}

export function clearMutedCategories(): void {
  persist(new Set());
}

export function subscribeMutedCategories(fn: Listener): () => void {
  listeners.add(fn);
  if (typeof window !== "undefined") {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) emit(loadMutedCategories());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }
  return () => { listeners.delete(fn); };
}
