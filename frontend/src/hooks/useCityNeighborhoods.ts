"use client";

import { useEffect, useState } from "react";
import {
  loadCityNeighborhoods,
  onCityNeighborhoodsLoaded,
} from "@/lib/neighborhoods";
import { getCurrentCity } from "@/lib/pulse-cities";

/**
 * Load (lazily) the active city's neighborhood polygon JSON and
 * trigger a re-render when it lands.
 *
 * Components that draw the district overlay (`IncidentMap`) call
 * this so:
 *   - the polygon file is fetched on first map mount, not at app
 *     boot — keeps the initial JS bundle lean,
 *   - the map auto-redraws once the file lands, swapping rectangles
 *     for true polygons without a manual reload,
 *   - cities without lazy data (Philly is bundled inline; cities
 *     with no JSON file shipped) are no-ops.
 *
 * Returns a `ready` boolean that flips to true once data is loaded
 * (or known to be unavailable) and a `version` number that bumps
 * every time data lands for the active city — handy as a `useEffect`
 * dep / `key` to force redraws.
 */
export function useCityNeighborhoods() {
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const slug = getCurrentCity().slug;
    let cancelled = false;
    loadCityNeighborhoods(slug)
      .then(() => {
        if (cancelled) return;
        setReady(true);
        setVersion((v) => v + 1);
      })
      .catch(() => {
        if (cancelled) return;
        setReady(true); // failed but we're "done waiting"
      });
    const unsub = onCityNeighborhoodsLoaded((loadedSlug) => {
      if (loadedSlug === slug) setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return { ready, version };
}
