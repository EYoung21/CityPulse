"use client";

/** Quiet-hours config — controls when notifications + non-critical
 *  voice cues should be suppressed. Driven by the user from the
 *  Alerts Inbox panel; persisted via prefs-sync so it travels with
 *  the account.
 *
 *  Scope:
 *    - OS notifications via `notifyIfBackgrounded` are suppressed.
 *    - Voice cues with priority "alert" / "info" are suppressed.
 *    - Voice cues with priority "turn" still speak — silencing turn
 *      directions during nav would be actively dangerous.
 *    - The inbox still records every alert so the user can review
 *      what they missed once quiet hours end. Each entry could
 *      optionally be flagged as muted, but that's noise; the
 *      "audible delivery" is the only thing the user controls here.
 *
 *  Window math:
 *    Wraps midnight cleanly. e.g. 22:00 → 07:00 covers both 23:30
 *    and 02:30. Stored as numeric hours-of-day (0..23) plus a
 *    minute granularity in 15-min steps for simple UI pickers. */

import { setPref } from "@/lib/prefs-sync";

const KEY = "pp:quiet-hours";

export interface QuietHoursConfig {
  enabled: boolean;
  /** 0..23 — local hour the quiet window starts. */
  startHour: number;
  /** 0..59, multiple of 15. */
  startMinute: number;
  /** 0..23 — local hour the quiet window ends (exclusive). */
  endHour: number;
  endMinute: number;
}

const DEFAULT: QuietHoursConfig = {
  enabled: false,
  startHour: 22,
  startMinute: 0,
  endHour: 7,
  endMinute: 0,
};

type Listener = (cfg: QuietHoursConfig) => void;
const listeners = new Set<Listener>();

function clampHour(h: number): number {
  if (!Number.isFinite(h)) return 0;
  return Math.max(0, Math.min(23, Math.round(h)));
}
function clampMinute(m: number): number {
  if (!Number.isFinite(m)) return 0;
  // Snap to 15-min grid so the picker UI stays simple.
  return Math.max(0, Math.min(45, Math.round(m / 15) * 15));
}

function normalize(c: Partial<QuietHoursConfig> | null | undefined): QuietHoursConfig {
  if (!c) return DEFAULT;
  return {
    enabled: Boolean(c.enabled),
    startHour: clampHour(c.startHour ?? DEFAULT.startHour),
    startMinute: clampMinute(c.startMinute ?? DEFAULT.startMinute),
    endHour: clampHour(c.endHour ?? DEFAULT.endHour),
    endMinute: clampMinute(c.endMinute ?? DEFAULT.endMinute),
  };
}

export function loadQuietHours(): QuietHoursConfig {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<QuietHoursConfig>;
    return normalize(parsed);
  } catch {
    return DEFAULT;
  }
}

export function saveQuietHours(patch: Partial<QuietHoursConfig>): QuietHoursConfig {
  const next = normalize({ ...loadQuietHours(), ...patch });
  try { setPref(KEY, JSON.stringify(next)); }
  catch { /* storage full — non-fatal */ }
  for (const fn of listeners) {
    try { fn(next); } catch { /* ignore single bad subscriber */ }
  }
  return next;
}

export function subscribeQuietHours(fn: Listener): () => void {
  listeners.add(fn);
  // Cross-tab: pick up changes from the storage event so two windows
  // stay in sync without polling.
  if (typeof window !== "undefined") {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) fn(loadQuietHours());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }
  return () => { listeners.delete(fn); };
}

/** True when local-clock `now` falls inside the configured quiet
 *  window. Handles midnight-wrap windows (22:00 → 07:00) by computing
 *  start-minute and end-minute since midnight and treating the window
 *  as a circular range. */
export function isQuietNow(now: Date = new Date(), cfg: QuietHoursConfig = loadQuietHours()): boolean {
  if (!cfg.enabled) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = cfg.startHour * 60 + cfg.startMinute;
  const end = cfg.endHour * 60 + cfg.endMinute;
  if (start === end) return false; // zero-length window = disabled
  if (start < end) {
    // Same-day window, e.g. 13:00 → 17:00.
    return cur >= start && cur < end;
  }
  // Wraps midnight: 22:00 → 07:00.
  return cur >= start || cur < end;
}

/** Format a window as "10:00 PM – 7:00 AM" using the user's locale. */
export function formatQuietWindow(cfg: QuietHoursConfig): string {
  const fmt = (h: number, m: number) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };
  return `${fmt(cfg.startHour, cfg.startMinute)} – ${fmt(cfg.endHour, cfg.endMinute)}`;
}
