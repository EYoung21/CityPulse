"use client";

/**
 * SafeRouteSection
 *
 * Two-column block inserted after the hero that demos the safer-routing
 * pitch. Owns the cycling state machine:
 *
 *   - every 6s advances to the next city.routeDemoPairs entry
 *   - when a new pair becomes active the canvas resets & animates routes
 *   - ~2.2s after the pair change we switch the picker's selected row
 *     from "fast" → "safer" so the viewer sees the app "choosing safety"
 *
 * Respects prefers-reduced-motion by pausing the auto-cycle (still shows
 * the first pair with the safer row already selected).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type maplibregl from "maplibre-gl";
import type { PulseCity } from "@/lib/pulse-cities";
import { CityMapCanvas, type LngLatBounds } from "./CityMapCanvas";
import { SafeRouteCanvas } from "./SafeRouteCanvas";
import { SafeRoutePicker } from "./SafeRoutePicker";

const CYCLE_MS = 6000;
const SAFER_DELAY_MS = 2200;

interface Props {
  city: PulseCity;
}

export function SafeRouteSection({ city }: Props) {
  const pairs = useMemo(() => city.routeDemoPairs ?? [], [city.routeDemoPairs]);
  const brand = city.brand ?? city.name;
  const accentRgb = city.accentRgb ?? "171, 255, 2";
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState<"fast" | "safer">("fast");
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  const handleMapReady = useCallback((m: maplibregl.Map) => {
    setMap(m);
  }, []);

  useEffect(() => {
    if (pairs.length === 0) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // Delayed "safer" switch for the current pair.
    const saferTimer = window.setTimeout(
      () => setSelected("safer"),
      reduce ? 0 : SAFER_DELAY_MS,
    );

    if (reduce || pairs.length === 1) {
      return () => window.clearTimeout(saferTimer);
    }

    const cycleTimer = window.setInterval(() => {
      setSelected("fast");
      setIdx((i) => (i + 1) % pairs.length);
    }, CYCLE_MS);

    return () => {
      window.clearTimeout(saferTimer);
      window.clearInterval(cycleTimer);
    };
    // Re-run the effect when `idx` changes so the delayed "safer" flip
    // fires once per cycle, not only on mount.
  }, [idx, pairs.length]);

  // Per-pair camera bounds: the bbox of from/to/hot + all blips,
  // expanded a hair so endpoints don't sit on the canvas edge. This is
  // what fixes the "route runs off the map" framing the screenshot
  // showed for the long Chattanooga pair.
  const bounds = useMemo<LngLatBounds | undefined>(() => {
    if (pairs.length === 0) return undefined;
    const p = pairs[idx];
    const lngs = [
      p.fromLngLat[0],
      p.toLngLat[0],
      p.hotLngLat[0],
      ...p.blips.map((b) => b.lng),
    ];
    const lats = [
      p.fromLngLat[1],
      p.toLngLat[1],
      p.hotLngLat[1],
      ...p.blips.map((b) => b.lat),
    ];
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    // Pad ~12% on each side so the curved bezier control points and
    // verdict badges have breathing room.
    const padLng = Math.max((maxLng - minLng) * 0.18, 0.004);
    const padLat = Math.max((maxLat - minLat) * 0.18, 0.003);
    return [
      [minLng - padLng, minLat - padLat],
      [maxLng + padLng, maxLat + padLat],
    ];
  }, [pairs, idx]);

  if (pairs.length === 0) return null;

  const pair = pairs[idx];

  return (
    <section id="logistics" className="lp-route-section lp-persona-section" aria-label="Safer routing demo">
      <div className="lp-route-section-inner">
        <header className="lp-route-section-head">
          <div
            className="lp-hero-channel lp-hero-channel--compact lp-route-section-eyebrow"
            role="status"
            aria-label="Route comparison demo"
          >
            <span className="lp-hero-channel__pulse" aria-hidden="true" />
            <p className="lp-hero-channel__line" style={{ margin: 0 }}>
              Corridor compare
            </p>
          </div>
          <h2 className="lp-route-section-title">Routed around, not through.</h2>
          <p className="lp-route-section-sub">
            Two routes, same destination. One crosses an active incident
            corridor. {brand} routes you through the other.
          </p>
        </header>

        <div className="lp-route-section-grid">
          <div className="lp-route-canvas-wrap">
            <CityMapCanvas
              className="lp-route-map"
              city={city}
              zoom={13.2}
              pitch={25}
              bearing={-12}
              drift={false}
              bounds={bounds}
              boundsPadding={64}
              onReady={handleMapReady}
            />
            <SafeRouteCanvas
              className="lp-route-overlay"
              city={city}
              map={map}
              activePairIndex={idx}
            />
            <div className="lp-route-canvas-legend">
              <span className="lp-route-legend-item">
                <span className="lp-route-legend-dot lp-route-legend-dot--fast" />
                Fastest
              </span>
              <span className="lp-route-legend-item">
                <span className="lp-route-legend-dot lp-route-legend-dot--safer" />
                Safer
              </span>
              <span className="lp-route-legend-item">
                <span className="lp-route-legend-dot lp-route-legend-dot--hot" />
                Hot zone
              </span>
            </div>
          </div>

          <div className="lp-route-picker-wrap">
            <SafeRoutePicker
              pair={pair}
              selected={selected}
              accentRgb={accentRgb}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
