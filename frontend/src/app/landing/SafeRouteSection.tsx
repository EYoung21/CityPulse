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

import { useEffect, useState } from "react";
import type { PulseCity } from "@/lib/pulse-cities";
import { SafeRouteCanvas } from "./SafeRouteCanvas";
import { SafeRoutePicker } from "./SafeRoutePicker";

const CYCLE_MS = 6000;
const SAFER_DELAY_MS = 2200;

interface Props {
  city: PulseCity;
}

export function SafeRouteSection({ city }: Props) {
  const pairs = city.routeDemoPairs;
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState<"fast" | "safer">("fast");

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

  if (pairs.length === 0) return null;

  const pair = pairs[idx];

  return (
    <section className="lp-route-section" aria-label="Safer routing demo">
      <div className="lp-route-section-inner">
        <header className="lp-route-section-head">
          <span className="lp-hero-eyebrow lp-route-section-eyebrow">
            <span className="lp-hero-live-dot" />
            <span>Safer routing</span>
          </span>
          <h2 className="lp-route-section-title">Routed around, not through.</h2>
          <p className="lp-route-section-sub">
            Two routes, same destination. One crosses an active incident
            corridor — {city.brand} routes you through the other.
          </p>
        </header>

        <div className="lp-route-section-grid">
          <div className="lp-route-canvas-wrap">
            <SafeRouteCanvas
              className="lp-route-canvas"
              city={city}
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
              accentRgb={city.accentRgb}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
