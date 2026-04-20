/** Vector-tile basemap support (beta).
 *
 *  PhillyPulse renders its overlays through Leaflet because the entire
 *  marker / cluster / heatmap / polyline pipeline is built on Leaflet
 *  primitives. Migrating that wholesale to MapLibre's WebGL renderer
 *  would be a multi-week refactor.
 *
 *  The pragmatic middle ground — and what this module enables — is the
 *  `@maplibre/maplibre-gl-leaflet` adapter: it slots a MapLibreGL
 *  WebGL canvas in as the base "tile" layer of an otherwise-untouched
 *  Leaflet map. The user gets crisp vector tiles (sharp labels, smooth
 *  GPU zoom, less bandwidth on retina displays) without us having to
 *  rewrite a single marker.
 *
 *  Trade-offs we accept by going this route:
 *    - No native rotation/pitch (Leaflet still owns the camera).
 *    - The MapLibre layer is a "passive" canvas — interactive vector
 *      features (e.g. clickable POIs in the basemap) are not exposed.
 *      Our markers and overlays already cover that need.
 *    - One extra GPU buffer at runtime, which is fine for a single
 *      basemap layer but worth keeping in mind if we ever stack vector
 *      overlays.
 *
 *  Persistence is in `localStorage` with the same `pp:` prefix our
 *  other prefs use. Subscribers can listen for changes so the map
 *  view can re-mount its base layer in place.
 */

const STORAGE_KEY = "pp:vector-tiles";

import type { BasemapStyle } from "@/components/IncidentMap";

/** Public Carto vector styles. They mirror our raster basemap choices
 *  one-for-one so a user toggling "Vector tiles (beta)" doesn't lose
 *  the visual feel they picked in the Basemap section. */
const CARTO_VECTOR_STYLE_URLS: Record<BasemapStyle, string> = {
  positron: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  voyager:  "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  dark:     "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  // No first-party vector equivalent for OSM Standard — fall back to
  // Voyager which is the closest "general purpose color" style.
  streets:  "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  // "auto" gets resolved by the caller; this entry only exists so the
  // `Record` type stays exhaustive.
  auto:     "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
};

export function vectorBasemapStyleUrl(
  style: BasemapStyle,
  isDark: boolean
): string {
  const resolved: BasemapStyle =
    style === "auto" ? (isDark ? "dark" : "voyager") : style;
  return CARTO_VECTOR_STYLE_URLS[resolved];
}

let _enabled: boolean = (() => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
})();

const listeners = new Set<(v: boolean) => void>();

export function isVectorTilesEnabled(): boolean {
  return _enabled;
}

export function setVectorTilesEnabled(value: boolean): void {
  const v = !!value;
  if (v === _enabled) return;
  _enabled = v;
  if (typeof window !== "undefined") {
    try {
      if (v) window.localStorage.setItem(STORAGE_KEY, "1");
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* localStorage may be disabled in private mode */
    }
  }
  for (const fn of listeners) {
    try { fn(v); } catch { /* swallow listener errors */ }
  }
}

export function subscribeVectorTiles(fn: (v: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React hook wrapper. Defined here (instead of a separate `useX`
 *  hook file) because consumers always want the boolean *and* the
 *  setter together — colocating the storage and the binding keeps
 *  the API surface small. */
import { useEffect, useState, useCallback } from "react";

export function useVectorTiles(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState(_enabled);
  useEffect(() => {
    setEnabled(_enabled);
    return subscribeVectorTiles(setEnabled);
  }, []);
  const set = useCallback((v: boolean) => setVectorTilesEnabled(v), []);
  return [enabled, set];
}
