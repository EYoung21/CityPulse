"use client";

/**
 * CityMapCanvas
 *
 * Non-interactive MapLibre wrapper rendering Carto's public dark-matter
 * vector style centered on the current PulseCity. This is the same tile
 * style the in-app map offers as the "dark" basemap
 * (see frontend/src/lib/vector-basemap.ts), so the landing page reads as
 * a continuation of the product — not a separate marketing surface.
 *
 * Responsibilities:
 *   - Fixed, non-interactive camera (no zoom/pan by the user).
 *   - Slow decorative bearing + pan drift so the background feels alive.
 *   - Accent-tinted vignette overlay so the map stays on-brand per city
 *     and doesn't look like a generic Carto dark map.
 *   - Respects prefers-reduced-motion (freezes the drift).
 *   - Releases its GL context on unmount.
 */

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { PulseCity } from "@/lib/pulse-cities";

const CARTO_DARK_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

interface Props {
  className?: string;
  city: PulseCity;
  /** Initial zoom; hero ~11.3, safe-route ~13.2. */
  zoom?: number;
  /** Pitched camera, 0..60. Slight pitch gives the map a 3D feel. */
  pitch?: number;
  /** Initial bearing in degrees. */
  bearing?: number;
  /** Enable slow bearing drift while mounted. */
  drift?: boolean;
}

export function CityMapCanvas({
  className,
  city,
  zoom = 11.3,
  pitch = 35,
  bearing = -17,
  drift = true,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!ref.current) return;

    const map = new maplibregl.Map({
      container: ref.current,
      style: CARTO_DARK_STYLE,
      center: [city.lng, city.lat],
      zoom,
      pitch,
      bearing,
      interactive: false,
      attributionControl: false,
      // Avoid flashing default blue before style loads.
      fadeDuration: 300,
    });
    mapRef.current = map;

    // Add a minimal attribution once the style is loaded. Carto requires
    // OSM + Carto credit when using the free style.
    map.on("load", () => {
      map.addControl(
        new maplibregl.AttributionControl({
          compact: true,
          customAttribution:
            '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a> · <a href="https://carto.com/attributions" target="_blank" rel="noopener">Carto</a>',
        }),
        "bottom-right",
      );
    });

    // Drift: slowly rotate bearing & pan so the map feels alive.
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let startTs: number | null = null;
    const startBearing = bearing;

    function animate(ts: number) {
      if (startTs === null) startTs = ts;
      const elapsed = (ts - startTs) / 1000; // seconds
      // Full 60-second loop: bearing drifts +30°, center nudges by
      // a few thousandths of a degree in a circle.
      const p = (elapsed / 60) % 1;
      const theta = p * Math.PI * 2;
      const dLng = Math.cos(theta) * 0.006;
      const dLat = Math.sin(theta) * 0.004;
      map.jumpTo({
        center: [city.lng + dLng, city.lat + dLat],
        bearing: startBearing + p * 30,
      });
      raf = requestAnimationFrame(animate);
    }

    if (drift && !reduce) raf = requestAnimationFrame(animate);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      mapRef.current = null;
      map.remove();
    };
    // Re-init when city changes; cheaper than fly-to because we also
    // want to reset the drift phase cleanly.
  }, [city, zoom, pitch, bearing, drift]);

  return (
    <div className={className} aria-hidden="true">
      <div ref={ref} className="lp-map-canvas" />
      <div className="lp-map-tint" />
    </div>
  );
}
