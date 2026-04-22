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
 *   - Optional hero-incident markers anchored to lng/lat — they follow
 *     the camera drift "for free" via maplibregl.Marker.
 *   - Imperative handle so siblings (e.g. SafeRouteCanvas) can grab the
 *     same map instance for `map.project(lngLat)` projection.
 *   - Respects prefers-reduced-motion (freezes the drift).
 *   - Releases its GL context on unmount.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { HeroIncident, PulseCity } from "@/lib/pulse-cities";
import {
  createBlipElement,
  createClusterElement,
} from "./landing-glyphs";

const CARTO_DARK_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

export interface CityMapCanvasHandle {
  /** Returns the underlying MapLibre instance once available, else null. */
  getMap: () => maplibregl.Map | null;
  /** Resolves once the map's style has finished loading. */
  ready: () => Promise<maplibregl.Map>;
}

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
  /** Optional anchored markers painted on top of the map. */
  incidents?: HeroIncident[];
  /** Fired once the map's style finished loading. */
  onReady?: (map: maplibregl.Map) => void;
}

export const CityMapCanvas = forwardRef<CityMapCanvasHandle, Props>(
  function CityMapCanvas(
    {
      className,
      city,
      zoom = 11.3,
      pitch = 35,
      bearing = -17,
      drift = true,
      incidents,
      onReady,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const readyPromiseRef = useRef<Promise<maplibregl.Map> | null>(null);
    const readyResolveRef = useRef<((m: maplibregl.Map) => void) | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        getMap: () => mapRef.current,
        ready: () => {
          if (readyPromiseRef.current) return readyPromiseRef.current;
          // No map yet — return a never-resolving promise; callers should
          // also pass `onReady` for the typical case.
          return new Promise<maplibregl.Map>(() => {});
        },
      }),
      [],
    );

    useEffect(() => {
      if (!containerRef.current) return;

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: CARTO_DARK_STYLE,
        center: [city.lng, city.lat],
        zoom,
        pitch,
        bearing,
        interactive: false,
        attributionControl: false,
        fadeDuration: 300,
      });
      mapRef.current = map;

      readyPromiseRef.current = new Promise<maplibregl.Map>((resolve) => {
        readyResolveRef.current = resolve;
      });

      map.on("load", () => {
        map.addControl(
          new maplibregl.AttributionControl({
            compact: true,
            customAttribution:
              '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a> · <a href="https://carto.com/attributions" target="_blank" rel="noopener">Carto</a>',
          }),
          "bottom-right",
        );
        readyResolveRef.current?.(map);
        onReady?.(map);
      });

      // Drift: slowly pan + rotate so the map feels alive. We use
      // jumpTo() inside a rAF loop instead of easeTo() — easeTo()
      // queues animations and ours is meant to be perpetually moving.
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

      let raf = 0;
      let startTs: number | null = null;
      const startBearing = bearing;

      function animate(ts: number) {
        if (startTs === null) startTs = ts;
        const elapsed = (ts - startTs) / 1000;
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
        readyPromiseRef.current = null;
        readyResolveRef.current = null;
        map.remove();
      };
    }, [city, zoom, pitch, bearing, drift, onReady]);

    /* ── Hero incident markers (anchored) ─────────────────────────── */
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !incidents || incidents.length === 0) return;

      const markers: maplibregl.Marker[] = [];

      const mount = () => {
        for (const inc of incidents) {
          const el =
            inc.kind === "cluster"
              ? createClusterElement(inc.count ?? 2)
              : createBlipElement({ kind: inc.kind, size: 22 });
          // Stagger pulse phase per marker so they don't pulse in
          // lockstep — feels like independent live events.
          el.style.animationDelay = `${(Math.random() * 1.8).toFixed(2)}s`;
          const m = new maplibregl.Marker({ element: el, anchor: "center" })
            .setLngLat([inc.lng, inc.lat])
            .addTo(map);
          markers.push(m);
        }
      };

      // If style is already loaded we can mount immediately, otherwise
      // wait for the readiness promise.
      if (map.isStyleLoaded()) {
        mount();
      } else {
        let cancelled = false;
        readyPromiseRef.current?.then(() => {
          if (!cancelled) mount();
        });
        return () => {
          cancelled = true;
          for (const m of markers) m.remove();
        };
      }

      return () => {
        for (const m of markers) m.remove();
      };
    }, [incidents]);

    return (
      <div className={className} aria-hidden="true">
        <div ref={containerRef} className="lp-map-canvas" />
        <div className="lp-map-tint" />
      </div>
    );
  },
);
