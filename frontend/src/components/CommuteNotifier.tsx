"use client";

/** Mounted once at the app root by `page.tsx`. Polls the predictive
 *  commute notifier every minute (and on focus / trip-history
 *  changes), so a Web Notification fires when the user is close to
 *  a recurring departure time.
 *
 *  All gating (opt-in flag, browser permission, quiet hours, fired-
 *  today) lives in `lib/commute-notify.ts`; this component just
 *  drives the loop. It renders no UI. */

import { useEffect } from "react";
import { useSavedDestinations } from "@/hooks/useSavedDestinations";
import { useAuth } from "@/contexts/AuthContext";
import {
  evaluateCommuteNotification,
  isCommuteNotificationsEnabled,
} from "@/lib/commute-notify";
import { predictNextCommute } from "@/lib/commute-patterns";
import { upsertCommuteSchedule } from "@/lib/commute-schedule-sync";
import { subscribeTripHistory } from "@/lib/trip-history";

const POLL_MS = 60_000;

function planRoute(label: string, dest: { lat: number; lng: number }): void {
  // The existing routing surface (DirectionsPanel + SearchSidebar)
  // listens for `pp:plan-route`, so we just dispatch the same event
  // here and the panel opens with the destination pre-filled.
  window.dispatchEvent(
    new CustomEvent("pp:plan-route", {
      detail: { mode: "to", lat: dest.lat, lng: dest.lng, label },
    })
  );
}

export default function CommuteNotifier() {
  const { destinations } = useSavedDestinations();
  const { user } = useAuth();

  useEffect(() => {
    let cancelled = false;
    let lastSyncedBucket = "";
    let lastSyncMs = 0;
    const tick = () => {
      if (cancelled) return;
      void evaluateCommuteNotification(destinations, planRoute);
      // Best-effort server-side sync: if the user is signed in and
      // has commute notifications opted in, push the current
      // prediction up to Firestore so the FastAPI cron can fire it
      // even if the tab is fully closed at departure time.
      // We rate-limit to once per 30 min per bucket to keep writes
      // off the critical path; the prediction shape is stable
      // enough that more frequent uploads aren't useful.
      if (
        user &&
        !user.isAnonymous &&
        isCommuteNotificationsEnabled()
      ) {
        try {
          const prediction = predictNextCommute(destinations);
          if (prediction && prediction.confidence >= 0.5) {
            const now = Date.now();
            const sameBucket = prediction.bucketKey === lastSyncedBucket;
            const recent = sameBucket && now - lastSyncMs < 30 * 60_000;
            if (!recent) {
              lastSyncedBucket = prediction.bucketKey;
              lastSyncMs = now;
              void upsertCommuteSchedule(user.uid, prediction).catch(() => {
                // Sync failures are silent; the in-tab notifier
                // still works and the next tick will retry.
                lastSyncMs = 0;
              });
            }
          }
        } catch {
          /* predictor failures shouldn't break the tick loop */
        }
      }
    };

    // Run immediately on mount + every minute. The predictor itself
    // is cheap (small in-memory dataset) so polling beats pinning a
    // wall-clock alarm we'd have to reschedule across DST.
    tick();
    const id = window.setInterval(tick, POLL_MS);

    // Tab returning to focus is a good moment to evaluate — the user
    // just looked at the device, so a slightly-late nudge is still
    // useful and we may have skipped intervals while throttled.
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);

    // Trip history changes (a fresh trip can flip a cluster from
    // 2 → 3 samples and unlock a prediction).
    const unsub = subscribeTripHistory(tick);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      unsub();
    };
  }, [destinations, user]);

  return null;
}
