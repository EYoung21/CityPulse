"use client";

/**
 * SecuritySection
 *
 * Persona deep-dive for event security / venue awareness. Two-column
 * layout matches SafeRouteSection. Cycling state machine advances a
 * time-window index every CYCLE_MS — heatmap blobs intensify, the
 * panel's active pill scrubs forward.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type maplibregl from "maplibre-gl";
import type { PulseCity } from "@/lib/pulse-cities";
import { CityMapCanvas, type LngLatBounds } from "./CityMapCanvas";
import { SecurityCanvas } from "./SecurityCanvas";
import { SecurityPanel } from "./SecurityPanel";

const CYCLE_MS = 2400;
const STEPS = 4;

interface Props {
  city: PulseCity;
}

export function SecuritySection({ city }: Props) {
  const accentRgb = city.accentRgb ?? "171, 255, 2";
  const prefersReducedMotion = typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [step, setStep] = useState(() => (prefersReducedMotion ? 2 : 0));
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  const handleMapReady = useCallback((m: maplibregl.Map) => {
    setMap(m);
  }, []);

  useEffect(() => {
    if (prefersReducedMotion) return;
    const timer = window.setInterval(() => {
      setStep((s) => (s + 1) % STEPS);
    }, CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [prefersReducedMotion]);

  const bounds = useMemo<LngLatBounds | undefined>(() => {
    const heros = city.heroIncidents ?? [];
    if (heros.length === 0) return undefined;
    const lngs = heros.map((h) => h.lng);
    const lats = heros.map((h) => h.lat);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const padLng = Math.max((maxLng - minLng) * 0.4, 0.008);
    const padLat = Math.max((maxLat - minLat) * 0.4, 0.006);
    return [
      [minLng - padLng, minLat - padLat],
      [maxLng + padLng, maxLat + padLat],
    ];
  }, [city]);

  return (
    <section
      id="security"
      className="lp-persona-section lp-security-section"
      aria-label="Event security situational awareness demo"
    >
      <div className="lp-route-section-inner">
        <header className="lp-route-section-head">
          <div
            className="lp-hero-channel lp-hero-channel--compact lp-route-section-eyebrow"
            role="status"
            aria-label="Event security awareness"
          >
            <span className="lp-hero-channel__pulse" aria-hidden="true" />
            <p className="lp-hero-channel__line" style={{ margin: 0 }}>
              Event security &middot; same map, longer view
            </p>
          </div>
          <h2 className="lp-route-section-title">
            Density and recency around the perimeter.
          </h2>
          <p className="lp-route-section-sub">
            Scrub the time window from &ldquo;right now&rdquo; out to
            72 hours. The heatmap, district overlays, and basemap stack
            stay on the same live map &mdash; no separate venue dashboard
            to manage.
          </p>
        </header>

        <div className="lp-route-section-grid">
          <div className="lp-route-canvas-wrap">
            <CityMapCanvas
              className="lp-route-map"
              city={city}
              zoom={13.2}
              pitch={28}
              bearing={-6}
              drift={false}
              bounds={bounds}
              boundsPadding={48}
              onReady={handleMapReady}
            />
            <SecurityCanvas
              className="lp-route-overlay"
              city={city}
              map={map}
              intensityStep={step}
              accentRgb={accentRgb}
            />
            <div className="lp-route-canvas-legend">
              <span className="lp-route-legend-item">
                <span
                  className="lp-route-legend-dot"
                  style={{ background: `rgb(${accentRgb})` }}
                />
                Density
              </span>
              <span className="lp-route-legend-item">
                <span
                  className="lp-route-legend-dot"
                  style={{
                    background: "transparent",
                    border: `2px solid rgb(${accentRgb})`,
                  }}
                />
                Perimeter
              </span>
            </div>
          </div>

          <div className="lp-route-picker-wrap">
            <SecurityPanel step={step} accentRgb={accentRgb} />
          </div>
        </div>
      </div>
    </section>
  );
}
