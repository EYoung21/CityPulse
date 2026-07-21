"use client";

import { useEffect, useRef } from "react";
import {
  activeReminders,
  markDelivered,
  subscribeReminders,
  type ScheduledReminder,
  type TripReminderPayload,
} from "@/lib/scheduled-reminders";
import { notifyIfBackgrounded } from "@/lib/notifications";
import { speakNav } from "@/lib/voice-nav";
import { isQuietNow } from "@/lib/quiet-hours";

const TICK_INTERVAL_MS = 30_000;
/** Anything older than this when we discover it on app load is shown as
 *  a "missed" banner. Beyond this window the reminder is considered
 *  too stale to surface — just mark delivered and move on. */
const MISSED_GRACE_MS = 6 * 60 * 60_000;

/** Headless runner mounted at the app root. Watches the scheduled-
 *  reminders store and fires foreground/background notifications when
 *  each one's `fireAt` arrives. Strategy:
 *    - On mount, sweep the list and arm a `setTimeout` per reminder
 *      whose target is < 12h away. Longer-out reminders rely on the
 *      30s polling tick so we don't hold long timers across tab
 *      hibernation.
 *    - On every store change (subscribeReminders), recompute timers.
 *    - On `visibilitychange`, sweep again — coming back from a sleeping
 *      tab can leave us behind on a reminder that should have fired
 *      while the timer was suspended.
 *    - When a reminder fires, dispatch `pp:trip-reminder` for the
 *      foreground UI to show a banner, attempt a system notification
 *      (best-effort), and speak a short voice cue. The reminder is
 *      then marked delivered.
 *
 *  We deliberately do NOT register a service-worker push subscription
 *  here — that needs a server-side VAPID setup to be useful. This
 *  client-side runner gives us "remind me while the tab is open" plus
 *  a "missed" banner the next time the user comes back, which covers
 *  the common case for a planner-style feature. */
export default function ReminderRunner() {
  const timersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    const fire = (reminder: ScheduledReminder, missed: boolean) => {
      // Idempotency guard: an alarm and a tick can both want to fire
      // the same reminder. The store's delivered flag is the source
      // of truth; if it's already set, just skip.
      const fresh = activeReminders().find((r) => r.id === reminder.id);
      if (!fresh) return;
      markDelivered(reminder.id);

      const payload: TripReminderPayload = { reminder, missed };
      try {
        window.dispatchEvent(new CustomEvent("pp:trip-reminder", { detail: payload }));
      } catch { /* ignore */ }

      const departLocal = new Date(reminder.departAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      const title = missed
        ? `Trip to ${reminder.destLabel}`
        : `Heads-up: trip in ${reminder.leadMinutes} min`;
      const body = missed
        ? `Was scheduled for ${departLocal}. Open to view route.`
        : `${reminder.destLabel} · leave by ${departLocal}`;

      void notifyIfBackgrounded({
        title,
        body,
        tag: `pp-reminder-${reminder.id}`,
        onClick: () => {
          // Re-dispatch the event so the foreground gets the banner
          // when the user clicks the system notification.
          try {
            window.dispatchEvent(new CustomEvent("pp:trip-reminder", { detail: payload }));
          } catch { /* ignore */ }
        },
      });

      if (!isQuietNow() && !missed) {
        speakNav(`Trip to ${reminder.destLabel} in ${reminder.leadMinutes} minutes`, {
          priority: "info",
          dedupeKey: `reminder-${reminder.id}`,
        });
      }
    };

    const sweep = () => {
      const now = Date.now();
      // Clear any timers whose reminders no longer exist (deleted /
      // delivered). We'll re-arm survivors below.
      for (const [id, handle] of timers.entries()) {
        window.clearTimeout(handle);
        timers.delete(id);
        void id;
      }
      const list = activeReminders();
      for (const r of list) {
        const delta = r.fireAt - now;
        if (delta <= 0) {
          const missed = now - r.fireAt > 30_000; // anything > 30s late
          if (now - r.fireAt > MISSED_GRACE_MS) {
            // Too stale to bother surfacing — just mark delivered so
            // we don't keep tripping over it on every sweep.
            markDelivered(r.id);
            continue;
          }
          fire(r, missed);
          continue;
        }
        // Cap setTimeout delays at ~12h. Anything longer rides the
        // polling tick — this avoids holding very long timers that
        // browsers throttle aggressively.
        if (delta < 12 * 60 * 60_000) {
          const handle = window.setTimeout(() => fire(r, false), delta);
          timers.set(r.id, handle);
        }
      }
    };

    sweep();
    const unsub = subscribeReminders(() => sweep());
    const tick = window.setInterval(sweep, TICK_INTERVAL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") sweep();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      unsub();
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVis);
      for (const handle of timers.values()) window.clearTimeout(handle);
      timers.clear();
    };
  }, []);

  return null;
}
