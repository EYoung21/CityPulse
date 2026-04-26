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
  useState,
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
    const [loaded, setLoaded] = useState(false);
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
      setLoaded(false);

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: CARTO_DARK_STYLE,
        center: [city.lng, city.lat],
        zoom,
        pitch,
        bearing,
        interactive: false,
        attributionControl: false,
        // Avoid an obvious "tiles fade in" flash on the landing hero.
        fadeDuration: 0,
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
        setLoaded(true);
      });

      const ro = new ResizeObserver(() => {
        map.resize();
      });
      ro.observe(containerRef.current);

      return () => {
        ro.disconnect();
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
        map.resize();
        // Expand the bbox to match the container's aspect ratio so the
        // data fills the full hero width instead of being squeezed into
        // a narrow central band. Without this, a square ~9×9km incident
        // bbox in a 1440×600 hero (2.4:1) ends up using only the middle
        // ~30% of the width, with empty metro on each side. We pad the
        // shorter axis (in earth-surface units, accounting for the
        // latitude lng-compression) until aspect matches, then fitBounds.
        const container = map.getContainer();
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        let fitTarget: LngLatBounds = bounds;
        if (cw > 0 && ch > 0) {
          const [[minLng, minLat], [maxLng, maxLat]] = bounds;
          const midLat = (minLat + maxLat) / 2;
          const cosLat = Math.cos((midLat * Math.PI) / 180) || 1;
          const bboxLngM = (maxLng - minLng) * cosLat;
          const bboxLatM = maxLat - minLat;
          const containerAspect = cw / ch;
          const bboxAspect = bboxLngM / bboxLatM;
          if (containerAspect > bboxAspect) {
            // Container wider — expand lng so bbox aspect matches.
            const targetLngM = bboxLatM * containerAspect;
            const extraLng = (targetLngM - bboxLngM) / cosLat;
            fitTarget = [
              [minLng - extraLng / 2, minLat],
              [maxLng + extraLng / 2, maxLat],
            ];
          } else {
            // Container taller — expand lat instead.
            const targetLatM = bboxLngM / containerAspect;
            const extraLat = targetLatM - bboxLatM;
            fitTarget = [
              [minLng, minLat - extraLat / 2],
              [maxLng, maxLat + extraLat / 2],
            ];
          }
        }
        map.fitBounds(fitTarget, {
          padding: boundsPadding,
          duration: 1200,
          pitch,
          bearing,
          essential: true,
        });
      };

      let cancelled = false;
      if (map.isStyleLoaded()) {
        apply();
      } else {
        readyPromiseRef.current?.then(() => {
          if (!cancelled) apply();
        });
      }

      // Refit on container resize (mobile rotation, sidebar collapse,
      // etc.) so the aspect-matched bbox stays correct.
      const ro = new ResizeObserver(() => {
        if (!cancelled && map.isStyleLoaded()) apply();
      });
      ro.observe(map.getContainer());

      return () => {
        cancelled = true;
        ro.disconnect();
      };
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
              : createBlipElement({ kind: inc.kind, size: 30 });
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
      <div
        className={className}
        aria-hidden="true"
        data-map-loaded={loaded ? "1" : "0"}
      >
        <div className="lp-map-placeholder" />
        <div ref={containerRef} className="lp-map-canvas" />
        <div className="lp-map-tint" />
      </div>
    );
  },
);
