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
import { evaluateCommuteNotification } from "@/lib/commute-notify";
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

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      void evaluateCommuteNotification(destinations, planRoute);
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
  }, [destinations]);

  return null;
}
