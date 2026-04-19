"use client";

/** Personal "avoid this area" blocklist.
 *
 *  Users can long-press (or right-click on desktop) anywhere on the
 *  map and choose "Avoid this area" → the spot is recorded as a
 *  circular avoid zone with a configurable radius. All future routing
 *  queries thread these zones into the existing ORS `avoid_polygons`
 *  request alongside the safety-driven incident zones.
 *
 *  Use cases:
 *    - "Don't ever route me past my ex's apartment"
 *    - "There's perpetual construction here that the map doesn't know"
 *    - "I take the long way around this overpass for personal reasons"
 *
 *  Storage:
 *    - Local: `pp:avoid-areas` in localStorage (already on the
 *      prefs-sync allow-list — these roam across devices)
 *    - Format: JSON array of {id, lat, lng, radiusM, label?, createdAt}
 *    - Capped at 50 entries to keep the avoid-polygons payload small
 *
 *  Why circles, not arbitrary polygons:
 *    - Easier UX (one tap + radius slider, vs draw-a-shape mode)
 *    - The routing layer already knows how to render circles into
 *      polygons via `buildAvoidPolygons` — we plug in here for free
 *    - Power users with a real polygon need can use the Manage panel
 *      to drop multiple overlapping circles
 */

import { setPref } from "@/lib/prefs-sync";
import type { AvoidZone } from "@/lib/routing";

export interface AvoidArea {
  /** Stable random id — used for deletion + cross-device dedupe. */
  id: string;
  lat: number;
  lng: number;
  /** Radius in meters; clamped to 25..1500 in the UI. */
  radiusM: number;
  /** Optional user label ("Construction zone", etc.). */
  label?: string;
  /** ms epoch — used to display "added 3 days ago" in the manage UI. */
  createdAt: number;
}

const KEY = "pp:avoid-areas";
const MAX_AREAS = 50;

type Listener = (areas: AvoidArea[]) => void;
const listeners = new Set<Listener>();

function emit(next: AvoidArea[]): void {
  for (const fn of listeners) {
    try { fn(next); } catch { /* ignore single bad subscriber */ }
  }
}

function genId(): string {
  // 9-char base36 — collision odds at <50 areas are negligible.
  return Math.random().toString(36).slice(2, 11);
}

export function loadAvoidAreas(): AvoidArea[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (a): a is AvoidArea =>
        a &&
        typeof a.id === "string" &&
        typeof a.lat === "number" &&
        typeof a.lng === "number" &&
        typeof a.radiusM === "number" &&
        typeof a.createdAt === "number"
    );
  } catch {
    return [];
  }
}

function persist(next: AvoidArea[]): void {
  if (typeof window === "undefined") return;
  try { setPref("pp:avoid-areas", JSON.stringify(next)); } catch { /* ignore */ }
  emit(next);
}

/** Add a new avoid area. Returns the saved entry (with generated id +
 *  timestamp). Caps at MAX_AREAS by evicting the oldest. */
export function addAvoidArea(input: {
  lat: number; lng: number; radiusM: number; label?: string;
}): AvoidArea {
  const entry: AvoidArea = {
    id: genId(),
    lat: input.lat,
    lng: input.lng,
    radiusM: Math.max(25, Math.min(1500, input.radiusM)),
    label: input.label?.slice(0, 60),
    createdAt: Date.now(),
  };
  let next = [entry, ...loadAvoidAreas()];
  if (next.length > MAX_AREAS) {
    // Evict oldest by createdAt to make room.
    next = next.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_AREAS);
  }
  persist(next);
  return entry;
}

export function removeAvoidArea(id: string): void {
  const next = loadAvoidAreas().filter((a) => a.id !== id);
  persist(next);
}

export function clearAvoidAreas(): void {
  persist([]);
}

export function updateAvoidArea(id: string, patch: Partial<Pick<AvoidArea, "radiusM" | "label">>): void {
  const next = loadAvoidAreas().map((a) =>
    a.id === id
      ? {
          ...a,
          ...(patch.radiusM != null ? { radiusM: Math.max(25, Math.min(1500, patch.radiusM)) } : {}),
          ...(patch.label != null ? { label: patch.label.slice(0, 60) } : {}),
        }
      : a
  );
  persist(next);
}

export function subscribeAvoidAreas(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Convert the user's avoid areas into the same `AvoidZone` shape the
 *  routing layer uses for incident-driven zones. The routing call
 *  concatenates these with `buildAvoidZones(...)` output and feeds the
 *  combined list to `buildAvoidPolygons` — ORS sees a single
 *  `avoid_polygons` request that respects both safety data and
 *  personal blocks. */
export function userAvoidZones(): AvoidZone[] {
  return loadAvoidAreas().map((a) => ({
    center: [a.lat, a.lng] as [number, number],
    radiusM: a.radiusM,
  }));
}

// Cross-tab + prefs-sync hydration: storage events fire in *other*
// tabs after a setItem (and after prefs-sync rewrites localStorage on
// sign-in). Mirror those into our pubsub so subscribers refresh.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) emit(loadAvoidAreas());
  });
}
