"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { shareValueFromUrl } from "@/lib/share-fragment";

/**
 * Decides whether the home route (`/`) should redirect to `/feed`.
 * Desktop keeps the embedded MapHome tabs. On mobile, an explicit feed hint
 * or saved feed preference opens the dedicated full-screen feed route.
 *
 * Override hierarchy (highest wins):
 *   1. `?view=map`  ........ explicit URL hint; sticks for future visits
 *   2. `?view=feed` ........ explicit URL hint; sticks for future visits
 *   3. `?view=analytics` ... home tab; never redirect
 *      `?view=ask` ......... retired tab; stay on the map
 *   4. `?incident=…` /
 *      `?lat=&lng=`  ....... share-link / deep-link; never redirect
 *   5. localStorage
 *      `cp:home-view` ...... user's most recent explicit choice
 *   6. otherwise ........... stay on / (map-first default)
 *
 * The hook is split into "decide synchronously on mount" + "navigate
 * in an effect" so the wrapping component can render nothing while
 * the redirect is in flight — avoiding a one-frame flash of the
 * full map-first home before bouncing.
 */
export type HomeRedirectDecision = "loading" | "stay" | "redirect";

const PREF_KEY = "cp:home-view";

export function decideHomeRedirect(isMobileViewport?: boolean): HomeRedirectDecision {
  if (typeof window === "undefined") return "loading";
  try {
    const url = new URL(window.location.href);
    const viewHint = url.searchParams.get("view");
    const isMobile = isMobileViewport ?? (
      typeof window.matchMedia === "function"
        ? window.matchMedia("(max-width: 767px)").matches
        : window.innerWidth <= 767
    );

    // Explicit URL hints win, and they're recorded as the new sticky
    // preference so the next bare visit to `/` honors the same choice.
    if (viewHint === "map") {
      try {
        localStorage.setItem(PREF_KEY, "map");
      } catch {
        /* private mode etc. — non-fatal */
      }
      return "stay";
    }
    if (viewHint === "feed") {
      try {
        localStorage.setItem(PREF_KEY, "feed");
      } catch {
        /* see above */
      }
      return isMobile ? "redirect" : "stay";
    }
    if (viewHint === "analytics" || viewHint === "ask") {
      return "stay";
    }

    // Deep links into the map (incident detail / dropped pin) always
    // win — those URLs only make sense on the map. The user can opt
    // back into feed-first home later.
    if (
      url.searchParams.has("incident") ||
      (url.searchParams.has("lat") && url.searchParams.has("lng")) ||
      url.searchParams.has("inbox") ||
      shareValueFromUrl(url, "trip", 64_000) !== null
    ) {
      return "stay";
    }

    let stickyPref: string | null = null;
    try {
      stickyPref = localStorage.getItem(PREF_KEY);
    } catch {
      stickyPref = null;
    }
    if (stickyPref === "map") return "stay";
    if (stickyPref === "feed") return isMobile ? "redirect" : "stay";

    // No explicit signal: map-first default.
    return "stay";
  } catch {
    // Anything weird (eg. storage exception in a sandboxed iframe)
    // → fall through to the safest behavior, which is "stay" so the
    // user actually sees something.
    return "stay";
  }
}

export function useMobileHomeRedirect(): HomeRedirectDecision {
  const router = useRouter();
  // Run `decide()` lazily so SSR returns "loading" and the browser
  // gets a real answer on its very first render — no useEffect delay.
  const [decision, setDecision] = useState<HomeRedirectDecision>(() => decideHomeRedirect());

  useEffect(() => {
    if (decision !== "loading") return;
    const id = window.setTimeout(() => setDecision(decideHomeRedirect()), 0);
    return () => window.clearTimeout(id);
  }, [decision]);

  useEffect(() => {
    if (decision === "redirect") {
      router.replace("/feed");
    }
  }, [decision, router]);

  return decision;
}
