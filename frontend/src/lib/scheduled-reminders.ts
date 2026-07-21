"use client";

/** Scheduled trip-departure reminders.
 *
 *  Lets the user say "remind me 10 minutes before this trip" when
 *  they're scheduling a future departure from the directions panel.
 *  When the reminder fires we:
 *    - dispatch a `pp:trip-reminder` event so the foreground UI can
 *      surface a toast / banner
 *    - call `notifyIfBackgrounded` so a backgrounded tab still gets
 *      a system notification (subject to permission + quiet hours)
 *    - speak a short voice cue if voice nav is enabled and we're not
 *      in quiet hours
 *
 *  Important honesty: without a registered Web Push subscription we
 *  cannot wake the browser when the tab is fully closed. The
 *  reminder will fire only while the tab is open or when the user
 *  comes back. To make that case useful, we *also* show a "missed"
 *  banner the next time the user opens the app for any reminder
 *  whose target time has already passed.
 *
 *  Storage:
 *    - localStorage key `pp:scheduled-reminders` holds the active
 *      list. Capped at 20 — anything beyond that is almost certainly
 *      stale and just bloating the payload.
 *    - Synced via prefs-sync so a reminder set on the desktop fires
 *      on the phone too (if the phone is open at the time, or shows
 *      the missed banner the next time).
 */

import { setPref } from "@/lib/prefs-sync";
import { isCoordinatePair } from "@/lib/geo-validation";

const KEY = "pp:scheduled-reminders";
const MAX_REMINDERS = 20;

export interface ScheduledReminder {
  id: string;
  /** Epoch ms — when the reminder should fire (departTime - leadMs). */
  fireAt: number;
  /** Epoch ms — actual planned departure time. */
  departAt: number;
  /** Minutes before departure the reminder is set for (display only). */
  leadMinutes: number;
  /** Short human label, used as the toast/notification title. */
  destLabel: string;
  destLat: number;
  destLng: number;
  /** ORS-style transport profile slug — kept opaque here so consumers
   *  don't have to translate. Stored for context (e.g. so a banner
   *  could show a Foot vs Car icon) but not currently surfaced. */
  mode: string;
  /** True once the reminder has been delivered (foreground or
   *  background). Kept around briefly so the missed-banner logic can
   *  see what it did. Auto-pruned after `DELIVERED_TTL_MS`. */
  delivered?: boolean;
  /** Epoch ms when delivery happened. */
  deliveredAt?: number;
}

export interface TripReminderPayload {
  reminder: ScheduledReminder;
  /** True when the reminder fired late (we caught it on next app open
   *  rather than at the exact moment), so the UI can phrase the
   *  banner differently ("You had a trip planned at 5:30 PM"). */
  missed: boolean;
}

const DELIVERED_TTL_MS = 24 * 60 * 60_000;

type Listener = (entries: ScheduledReminder[]) => void;
const listeners = new Set<Listener>();

function emit(next: ScheduledReminder[]): void {
  for (const fn of listeners) {
    try { fn(next); } catch { /* ignore */ }
  }
}

function nowMs(): number { return Date.now(); }

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function parseReminder(value: unknown): ScheduledReminder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const coordinates = [row.destLat, row.destLng];
  if (
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.fireAt !== "number" ||
    !Number.isFinite(row.fireAt) ||
    typeof row.departAt !== "number" ||
    !Number.isFinite(row.departAt) ||
    typeof row.leadMinutes !== "number" ||
    !Number.isFinite(row.leadMinutes) ||
    row.leadMinutes < 0 ||
    typeof row.destLabel !== "string" ||
    typeof row.mode !== "string" ||
    !isCoordinatePair(coordinates)
  ) return null;
  const deliveredAt = typeof row.deliveredAt === "number" && Number.isFinite(row.deliveredAt)
    ? row.deliveredAt
    : undefined;
  return {
    id: row.id.slice(0, 500),
    fireAt: row.fireAt,
    departAt: row.departAt,
    leadMinutes: Math.min(10_080, row.leadMinutes),
    destLabel: row.destLabel.slice(0, 1_000),
    destLat: coordinates[0],
    destLng: coordinates[1],
    mode: row.mode.slice(0, 100),
    delivered: row.delivered === true,
    deliveredAt,
  };
}

export function loadReminders(): ScheduledReminder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const cutoff = nowMs() - DELIVERED_TTL_MS;
    // Prune anything delivered & older than TTL so the list stays trim.
    return parsed
      .slice(0, MAX_REMINDERS)
      .map(parseReminder)
      .filter((r): r is ScheduledReminder =>
        r !== null && (!r.delivered || (r.deliveredAt ?? r.fireAt) >= cutoff)
      );
  } catch {
    return [];
  }
}

function persist(next: ScheduledReminder[]): void {
  try {
    setPref(KEY, JSON.stringify(next.slice(0, MAX_REMINDERS)));
  } catch { /* storage full / blocked */ }
  emit(next);
}

export function addReminder(
  input: Omit<ScheduledReminder, "id" | "delivered" | "deliveredAt">
): ScheduledReminder {
  const existing = loadReminders();
  const reminder: ScheduledReminder = { ...input, id: genId() };
  const next = [reminder, ...existing.filter((r) =>
    // Drop near-duplicate reminders for the same destination+departure
    // so re-toggling the lead time doesn't pile up rows.
    !(
      Math.abs(r.departAt - reminder.departAt) < 60_000 &&
      Math.abs(r.destLat - reminder.destLat) < 1e-4 &&
      Math.abs(r.destLng - reminder.destLng) < 1e-4
    )
  )];
  persist(next);
  return reminder;
}

export function removeReminder(id: string): void {
  const next = loadReminders().filter((r) => r.id !== id);
  persist(next);
}

export function markDelivered(id: string): void {
  const next = loadReminders().map((r) =>
    r.id === id ? { ...r, delivered: true, deliveredAt: nowMs() } : r
  );
  persist(next);
}

export function subscribeReminders(fn: Listener): () => void {
  listeners.add(fn);
  if (typeof window !== "undefined") {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) emit(loadReminders());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }
  return () => { listeners.delete(fn); };
}

/** Convenience: returns active (not-yet-delivered) reminders. */
export function activeReminders(): ScheduledReminder[] {
  return loadReminders().filter((r) => !r.delivered);
}
