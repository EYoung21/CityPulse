"use client";

/** Push-notification snooze.
 *
 *  Stores a single epoch-millisecond "until" timestamp under
 *  `pp:push-snooze-until` (synced via prefs-sync). Server-side push
 *  fan-outs read the same value via the synced prefs doc and skip
 *  delivery for any window where `now < until`.
 *
 *  Honest scope:
 *    - Snooze only suppresses *closed-tab* push notifications. The
 *      in-tab Alerts Inbox keeps recording everything; the user can
 *      still scroll through the missed events when they unsnooze.
 *    - Snooze does **not** suppress voice nav cues (those have their
 *      own quiet-hours interaction in `voice-nav.ts`) — silencing
 *      a turn instruction during nav would be unsafe.
 *    - Snooze is set in user-local time and stored as a UTC
 *      timestamp; "8 hours from now" stays correct across DST. */

import { setPref, getPref } from "@/lib/prefs-sync";

const KEY = "pp:push-snooze-until";
const MAX_SNOOZE_MS = 7 * 24 * 60 * 60_000;

export interface PushSnoozeState {
  active: boolean;
  /** Epoch ms when the snooze ends. Zero when inactive. */
  untilMs: number;
}

export function loadPushSnooze(): PushSnoozeState {
  const raw = getPref(KEY);
  if (!raw) return { active: false, untilMs: 0 };
  const n = Number(raw);
  const now = Date.now();
  if (!Number.isFinite(n) || n <= now || n > now + MAX_SNOOZE_MS) {
    return { active: false, untilMs: 0 };
  }
  return { active: true, untilMs: n };
}

export function setPushSnoozeUntil(untilMs: number | null): PushSnoozeState {
  const now = Date.now();
  if (!untilMs || !Number.isFinite(untilMs) || untilMs <= now) {
    // Clearing snooze writes "" (rather than removing the key) so the
    // synced prefs doc round-trips a "user explicitly unsnoozed"
    // signal, not a "this device hasn't seen the pref yet" silence.
    setPref(KEY, "");
    return { active: false, untilMs: 0 };
  }
  const cleanUntilMs = Math.min(now + MAX_SNOOZE_MS, Math.floor(untilMs));
  setPref(KEY, String(cleanUntilMs));
  return { active: true, untilMs: cleanUntilMs };
}

/** Snooze for a duration (in milliseconds) starting now. */
export function snoozeFor(durationMs: number): PushSnoozeState {
  const cleanDuration = Number.isFinite(durationMs)
    ? Math.max(60_000, Math.min(MAX_SNOOZE_MS, durationMs))
    : 60_000;
  return setPushSnoozeUntil(Date.now() + cleanDuration);
}

/** Snooze until the next local-time 7am — handles cross-midnight
 *  windows so "until tomorrow morning" doesn't silently mean
 *  "until 7am today" when invoked at 5am. */
export function snoozeUntilTomorrowMorning(): PushSnoozeState {
  const now = new Date();
  const target = new Date(now);
  target.setHours(7, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return setPushSnoozeUntil(target.getTime());
}

export function clearPushSnooze(): void {
  setPushSnoozeUntil(null);
}

/** Format the remaining snooze duration as a short human label.
 *  Used in the settings pill ("Snoozed · 47 min left"). */
export function formatSnoozeRemaining(untilMs: number): string {
  const diff = untilMs - Date.now();
  if (diff <= 0) return "ending";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "<1 min left";
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  const remM = m - h * 60;
  if (h < 24) return remM > 0 ? `${h}h ${remM}m left` : `${h}h left`;
  const d = Math.floor(h / 24);
  return `${d}d left`;
}
