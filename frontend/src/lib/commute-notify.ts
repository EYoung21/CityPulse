"use client";

/** Predictive "leaving for work" notification.
 *
 *  Wired up by `<CommuteNotifier />` (mounted in page.tsx). Once the
 *  user opts in (and grants OS notification permission), we poll the
 *  commute predictor each minute and fire a single Web Notification
 *  per matching bucket-per-day, a few minutes ahead of the typical
 *  departure time.
 *
 *  Design constraints:
 *    - **Opt-in only.** We never auto-prompt for notification
 *      permission; the toggle in Settings (or the affordance on the
 *      CommutePredictionPill) calls `enableCommuteNotifications`
 *      explicitly.
 *    - **Confidence floor.** A pattern with 3 trips can be a
 *      coincidence — we require `confidence >= MIN_CONFIDENCE` so we
 *      don't ping the user for one-off destinations.
 *    - **Quiet hours respected.** The shared `notifyIfBackgrounded`
 *      helper already short-circuits during quiet hours, but we also
 *      record the bucket as "fired" so we don't hammer it once the
 *      window ends.
 *    - **One per bucket per day.** A persisted set keyed by
 *      `YYYY-MM-DD:<bucketKey>` prevents duplicate pings if the user
 *      opens the app twice or the predictor briefly fluctuates.
 *    - **Foreground-aware.** When the page is visible the OS
 *      notification is suppressed (we already show the
 *      `CommutePredictionPill` in-app), but we still record the
 *      bucket so we don't pop the notification the moment they tab
 *      away. */

import {
  ensureNotificationPermission,
  notificationsSupported,
  notifyIfBackgrounded,
} from "@/lib/notifications";
import { isQuietNow } from "@/lib/quiet-hours";
import {
  formatDepartureTime,
  predictNextCommute,
  type CommutePrediction,
} from "@/lib/commute-patterns";
import type { SavedDestination } from "@/hooks/useSavedDestinations";

const ENABLED_KEY = "pp:commute-notify-enabled";
const FIRED_KEY = "pp:commute-notify-fired-v1";
const LEAD_MIN = 10;
const FIRE_WINDOW_MIN = 12;
const MIN_CONFIDENCE = 0.5;

export function isCommuteNotificationsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ENABLED_KEY) === "1";
  } catch { return false; }
}

/** Persist the user's opt-in choice. Does not request notification
 *  permission — call `enableCommuteNotifications` for that flow. */
export function setCommuteNotificationsEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch { /* storage blocked — non-fatal */ }
  // Other tabs / components subscribe to this so settings UI and the
  // notifier stay in sync without a full reload.
  window.dispatchEvent(new CustomEvent("pp:commute-notify-changed", { detail: { on } }));
}

/** Opt the user in. Requests notification permission as a side
 *  effect (returns false and stays opted out if denied). */
export async function enableCommuteNotifications(): Promise<boolean> {
  if (!notificationsSupported()) {
    setCommuteNotificationsEnabled(false);
    return false;
  }
  const granted = await ensureNotificationPermission();
  setCommuteNotificationsEnabled(granted);
  return granted;
}

function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface FiredRecord {
  /** YYYY-MM-DD */
  date: string;
  /** Set of bucket keys we've fired for `date`. */
  buckets: string[];
}

function loadFired(): FiredRecord {
  if (typeof window === "undefined") return { date: todayKey(), buckets: [] };
  try {
    const raw = window.localStorage.getItem(FIRED_KEY);
    if (!raw) return { date: todayKey(), buckets: [] };
    const parsed = JSON.parse(raw) as FiredRecord;
    if (parsed && typeof parsed.date === "string" && Array.isArray(parsed.buckets)) {
      // Reset at midnight by comparing against today's date — keeps
      // the persisted set from growing forever and lets the same
      // bucket fire again tomorrow.
      if (parsed.date !== todayKey()) return { date: todayKey(), buckets: [] };
      return {
        date: parsed.date.slice(0, 10),
        buckets: [...new Set(parsed.buckets.filter((bucket): bucket is string => typeof bucket === "string"))].slice(0, 200),
      };
    }
  } catch { /* ignore */ }
  return { date: todayKey(), buckets: [] };
}

function saveFired(rec: FiredRecord): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(FIRED_KEY, JSON.stringify(rec)); } catch { /* ignore */ }
}

function markFired(bucketKey: string): void {
  const rec = loadFired();
  if (rec.buckets.includes(bucketKey)) return;
  rec.buckets = [...rec.buckets, bucketKey];
  saveFired(rec);
}

function alreadyFired(bucketKey: string): boolean {
  const rec = loadFired();
  return rec.buckets.includes(bucketKey);
}

/** Returns true if `prediction` is currently inside the firing
 *  window (i.e. typical departure is between `LEAD_MIN` minutes from
 *  now and `LEAD_MIN - FIRE_WINDOW_MIN` ago). The window straddles
 *  the departure time so a brief tab-close around the exact moment
 *  doesn't lose the notification. */
function isInFireWindow(prediction: CommutePrediction, now = new Date()): boolean {
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  const minutesUntil = prediction.typicalDepartureMinute - nowMinute;
  // Wrap for late-night clusters near midnight.
  const wrapped = minutesUntil > 720 ? minutesUntil - 1440
                : minutesUntil < -720 ? minutesUntil + 1440
                : minutesUntil;
  return wrapped <= LEAD_MIN && wrapped >= LEAD_MIN - FIRE_WINDOW_MIN;
}

/** Single evaluation pass. Safe to call repeatedly; respects all
 *  the gates (enabled, permission, quiet hours, fired-today). The
 *  `onClickRoute` callback is invoked when the user clicks the
 *  notification *and* the original tab is still alive — caller is
 *  expected to dispatch a `pp:plan-route` event or otherwise open
 *  directions to the predicted destination. */
export async function evaluateCommuteNotification(
  savedDestinations: SavedDestination[],
  onClickRoute: (label: string, dest: { lat: number; lng: number }) => void
): Promise<void> {
  if (!isCommuteNotificationsEnabled()) return;
  if (!notificationsSupported()) return;
  // Quiet hours short-circuit before doing the prediction work to
  // avoid waking the predictor at 3am for nothing.
  if (isQuietNow()) return;

  const prediction = predictNextCommute(savedDestinations);
  if (!prediction) return;
  if (prediction.confidence < MIN_CONFIDENCE) return;
  if (!isInFireWindow(prediction)) return;
  if (alreadyFired(prediction.bucketKey)) return;

  const label =
    prediction.matchedCategory === "home" ? "Heading home"
    : prediction.matchedCategory === "work" ? "Heading to work"
    : `Heading to ${prediction.destLabel}`;
  const dep = formatDepartureTime(prediction.typicalDepartureMinute);
  const dur = Math.round(prediction.typicalDurationMin);

  // Mark as fired *before* the async notification call — if the user
  // races by reopening the tab, we'd rather under-notify than show
  // them the same nudge twice.
  markFired(prediction.bucketKey);

  await notifyIfBackgrounded({
    title: `${label} soon?`,
    body: `You usually leave around ${dep} · ~${dur}m. Tap to plan a safe route.`,
    tag: `commute-${prediction.bucketKey}`,
    onClick: () => {
      onClickRoute(prediction.destLabel, {
        lat: prediction.destLat,
        lng: prediction.destLng,
      });
    },
  });
}
