"use client";

/** Saved filter presets — name + (categories × time-window) snapshots.
 *
 *  Power users routinely flip back and forth between the same filter
 *  combinations ("just gun violence past 24h", "all violent crime past
 *  week", "property + drug, today"). Presets give them a single tap to
 *  restore a saved combo, and a place to share a useful view with
 *  themselves across devices via prefs-sync.
 *
 *  Storage:
 *    Keyed `pp:filter-presets` in localStorage; on the prefs-sync
 *    allow-list so presets roam with the user's account.
 *  Cap:
 *    Hard ceiling of 12 presets to keep the picker UI manageable
 *    (typical usage is 1–4). Adds beyond the cap evict the oldest.
 */

import { setPref } from "@/lib/prefs-sync";
import { normalizeTimeFilterHours } from "@/lib/time-filters";

export interface FilterPreset {
  /** Stable random id — used for delete + dedupe. */
  id: string;
  /** User-supplied label, ≤32 chars after trim. */
  name: string;
  /** Active severity_category strings. Empty array = "All". */
  cats: string[];
  /** Time-filter window in hours (matches `TIME_FILTERS[i].hours`). */
  timeFilterHours: number;
  /** ms epoch — used to evict the oldest when over the cap. */
  createdAt: number;
}

const KEY = "pp:filter-presets";
const MAX_PRESETS = 12;

type Listener = (presets: FilterPreset[]) => void;
const listeners = new Set<Listener>();

function emit(next: FilterPreset[]): void {
  for (const fn of listeners) {
    try { fn(next); } catch { /* ignore single bad subscriber */ }
  }
}

function genId(): string {
  return Math.random().toString(36).slice(2, 11);
}

export function loadPresets(): FilterPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, MAX_PRESETS).flatMap((value): FilterPreset[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const p = value as Record<string, unknown>;
      if (
        typeof p.id !== "string" ||
        !p.id ||
        typeof p.name !== "string" ||
        !Array.isArray(p.cats) ||
        typeof p.timeFilterHours !== "number" ||
        typeof p.createdAt !== "number" ||
        !Number.isFinite(p.createdAt) ||
        p.createdAt <= 0
      ) return [];
      return [{
        id: p.id.slice(0, 500),
        name: p.name.trim().slice(0, 32) || "Untitled",
        cats: [...new Set(p.cats.filter((cat): cat is string => typeof cat === "string").map((cat) => cat.slice(0, 100)))].slice(0, 100),
        timeFilterHours: normalizeTimeFilterHours(p.timeFilterHours),
        createdAt: p.createdAt,
      }];
    });
  } catch {
    return [];
  }
}

function persist(next: FilterPreset[]): void {
  if (typeof window === "undefined") return;
  try { setPref("pp:filter-presets", JSON.stringify(next)); } catch { /* ignore */ }
  emit(next);
}

export function addPreset(input: {
  name: string;
  cats: string[];
  timeFilterHours: number;
}): FilterPreset {
  const trimmed = input.name.trim().slice(0, 32) || "Untitled";
  const entry: FilterPreset = {
    id: genId(),
    name: trimmed,
    cats: [...new Set(input.cats.filter((cat) => typeof cat === "string").map((cat) => cat.slice(0, 100)))].slice(0, 100),
    timeFilterHours: normalizeTimeFilterHours(input.timeFilterHours),
    createdAt: Date.now(),
  };
  let next = [entry, ...loadPresets()];
  if (next.length > MAX_PRESETS) {
    // Evict oldest by createdAt.
    next = next.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_PRESETS);
  }
  persist(next);
  return entry;
}

export function removePreset(id: string): void {
  const next = loadPresets().filter((p) => p.id !== id);
  persist(next);
}

export function renamePreset(id: string, name: string): void {
  const trimmed = name.trim().slice(0, 32);
  if (!trimmed) return;
  const next = loadPresets().map((p) => (p.id === id ? { ...p, name: trimmed } : p));
  persist(next);
}

export function subscribePresets(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) emit(loadPresets());
  });
}
