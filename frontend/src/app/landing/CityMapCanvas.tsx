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
 * Effects are split so the GL context is created once per city and
 * subsequent prop changes (bounds, drift toggle, incident set) just
 * mutate the live map. That keeps the route minimap from flashing on
 * every 6-second pair cycle.
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

export type LngLatBounds = [[number, number], [number, number]];

interface Props {
  className?: string;
  city: PulseCity;
  /** Initial zoom; ignored when `bounds` is supplied. */
  zoom?: number;
  /** Pitched camera, 0..60. Slight pitch gives the map a 3D feel. */
  pitch?: number;
  /** Initial bearing in degrees. */
  bearing?: number;
  /** Enable slow bearing drift while mounted. */
  drift?: boolean;
  /** Optional anchored markers painted on top of the map. */
  incidents?: HeroIncident[];
  /** When provided, the camera fits to these bounds (and refits when
   *  they change). Drift is implicitly disabled. */
  bounds?: LngLatBounds;
  /** Padding (px) used when fitting bounds. */
  boundsPadding?: number;
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
      bounds,
      boundsPadding = 60,
      onReady,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const readyPromiseRef = useRef<Promise<maplibregl.Map> | null>(null);
    const readyResolveRef = useRef<((m: maplibregl.Map) => void) | null>(null);
    // Hold the latest onReady in a ref so we don't tear down the map
    // every time the parent re-renders with a new closure.
    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;

    useImperativeHandle(
      ref,
      () => ({
        getMap: () => mapRef.current,
        ready: () => {
          if (readyPromiseRef.current) return readyPromiseRef.current;
          return new Promise<maplibregl.Map>(() => {});
        },
      }),
      [],
    );

    /* ── Init: create the map once per city ──────────────────────── */
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
        onReadyRef.current?.(map);
      });

      return () => {
        mapRef.current = null;
        readyPromiseRef.current = null;
        readyResolveRef.current = null;
        map.remove();
      };
      // Intentionally only re-init when the city changes. Camera/drift
      // changes are applied by the effects below, in-place.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [city]);

    /* ── Bounds: fit when set, refit on change ───────────────────── */
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !bounds) return;

      const apply = () => {
        map.fitBounds(bounds, {
          padding: boundsPadding,
          duration: 1200,
          pitch,
          bearing,
          essential: true,
        });
      };

      if (map.isStyleLoaded()) {
        apply();
      } else {
        let cancelled = false;
        readyPromiseRef.current?.then(() => {
          if (!cancelled) apply();
        });
        return () => {
          cancelled = true;
        };
      }
    }, [bounds, boundsPadding, pitch, bearing]);

    /* ── Drift: slowly orbit + rotate (skipped when bounds is set) ─ */
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !drift || bounds) return;

      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduce) return;

      let raf = 0;
      let startTs: number | null = null;
      const startBearing = bearing;

      function animate(ts: number) {
        if (startTs === null) startTs = ts;
        const elapsed = (ts - startTs) / 1000;
        // Full 60-second loop.
        const p = (elapsed / 60) % 1;
        const theta = p * Math.PI * 2;
        const dLng = Math.cos(theta) * 0.006;
        const dLat = Math.sin(theta) * 0.004;
        map!.jumpTo({
          center: [city.lng + dLng, city.lat + dLat],
          bearing: startBearing + p * 30,
        });
        raf = requestAnimationFrame(animate);
      }
      raf = requestAnimationFrame(animate);

      return () => {
        if (raf) cancelAnimationFrame(raf);
      };
    }, [drift, bounds, city, bearing]);

    /* ── Incident markers (anchored) ─────────────────────────────── */
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
