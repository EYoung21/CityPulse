"use client";

/**
 * ResearchSection
 *
 * Persona deep-dive for research / public-good analysis. The cycle
 * increments `loadedCount` every CYCLE_MS — pins drop on the map and
 * rows fade in at the top of the feed table, simulating "streaming a
 * normalized incident dataset." When the count tops out, we hold for
 * a beat, then reset so the demo loops.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type maplibregl from "maplibre-gl";
import type { PulseCity } from "@/lib/pulse-cities";
import { CityMapCanvas, type LngLatBounds } from "./CityMapCanvas";
import { ResearchCanvas } from "./ResearchCanvas";
import { ResearchFeed } from "./ResearchFeed";
import { RESEARCH_ROWS } from "./research-rows";

const CYCLE_MS = 1500;
const HOLD_MS = 2200;

interface Props {
  city: PulseCity;
}

export function ResearchSection({ city }: Props) {
  const accentRgb = city.accentRgb ?? "171, 255, 2";
  const rows = RESEARCH_ROWS;
  const prefersReducedMotion = typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [count, setCount] = useState(() =>
    prefersReducedMotion ? rows.length : 1,
  );
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  const handleMapReady = useCallback((m: maplibregl.Map) => {
    setMap(m);
  }, []);

  useEffect(() => {
    if (prefersReducedMotion) return;

    const timer: number =
      count < rows.length
        ? window.setTimeout(() => setCount((c) => c + 1), CYCLE_MS)
        : window.setTimeout(() => setCount(1), HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [count, rows.length, prefersReducedMotion]);

  const bounds = useMemo<LngLatBounds | undefined>(() => {
    const heros = city.heroIncidents ?? [];
    if (heros.length === 0) return undefined;
    const lngs = heros.map((h) => h.lng);
    const lats = heros.map((h) => h.lat);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const padLng = Math.max((maxLng - minLng) * 0.3, 0.006);
    const padLat = Math.max((maxLat - minLat) * 0.3, 0.005);
    return [
      [minLng - padLng, minLat - padLat],
      [maxLng + padLng, maxLat + padLat],
    ];
  }, [city]);

  return (
    <section
      id="research"
      className="lp-persona-section lp-research-section"
      aria-label="Research and public-good analysis demo"
    >
      <div className="lp-route-section-inner">
        <header className="lp-route-section-head">
          <div
            className="lp-hero-channel lp-hero-channel--compact lp-route-section-eyebrow"
            role="status"
            aria-label="Research-grade incident stream"
          >
            <span className="lp-hero-channel__pulse" aria-hidden="true" />
            <p className="lp-hero-channel__line" style={{ margin: 0 }}>
              Research &middot; normalized stream
            </p>
          </div>
          <h2 className="lp-route-section-title">
            A clean schema you can actually analyze.
          </h2>
          <p className="lp-route-section-sub">
            Every transcript is geocoded, categorized, and timestamped &mdash;
            then served as a searchable, paginated stream. Public reads
            cover the last 3 days; <strong>Pro</strong> unlocks extended history
            and CSV export for longitudinal work.
          </p>
        </header>

        <div className="lp-route-section-grid">
          <div className="lp-route-canvas-wrap">
            <CityMapCanvas
              className="lp-route-map"
              city={city}
              zoom={12.6}
              pitch={20}
              bearing={-4}
              drift={false}
              bounds={bounds}
              boundsPadding={48}
              onReady={handleMapReady}
            />
            <ResearchCanvas
              city={city}
              map={map}
              rows={rows}
              loadedCount={count}
              accentRgb={accentRgb}
            />
            <div className="lp-route-canvas-legend">
              <span className="lp-route-legend-item">
                <span
                  className="lp-route-legend-dot"
                  style={{ background: `rgb(${accentRgb})` }}
                />
                Geocoded incident
              </span>
            </div>
          </div>

          <div className="lp-route-picker-wrap">
            <ResearchFeed
              rows={rows}
              loadedCount={count}
              accentRgb={accentRgb}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
