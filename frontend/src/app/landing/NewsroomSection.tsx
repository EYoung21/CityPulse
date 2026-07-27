"use client";

/**
 * NewsroomSection
 *
 * Persona deep-dive for the press / newsroom use case. Mirrors
 * SafeRouteSection's two-column layout and cycling state machine:
 *
 *   - every CYCLE_MS advances to the next NEWSROOM_EVENT
 *   - the canvas re-renders pulse markers (re-triggers the CSS pulse)
 *     and surfaces the active keyword inside the ticker chatter
 *   - the inbox mockup pulses the matching watch row and slides a fresh
 *     alert in at the top
 *
 * Respects prefers-reduced-motion by pausing the cycle on the first
 * event so the page still demonstrates the feature without movement.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type maplibregl from "maplibre-gl";
import type { PulseCity } from "@/lib/pulse-cities";
import { CityMapCanvas, type LngLatBounds } from "./CityMapCanvas";
import { NewsroomCanvas } from "./NewsroomCanvas";
import { NewsroomInbox } from "./NewsroomInbox";
import { NEWSROOM_EVENTS } from "./newsroom-events";

const CYCLE_MS = 5200;

interface Props {
  city: PulseCity;
}

export function NewsroomSection({ city }: Props) {
  const accentRgb = city.accentRgb ?? "171, 255, 2";
  const events = NEWSROOM_EVENTS;
  const [idx, setIdx] = useState(0);
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  const handleMapReady = useCallback((m: maplibregl.Map) => {
    setMap(m);
  }, []);

  useEffect(() => {
    if (events.length <= 1) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    const timer = window.setInterval(() => {
      setIdx((i) => (i + 1) % events.length);
    }, CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [events.length]);

  // Build bounds from heroIncidents so the camera frames them all.
  const bounds = useMemo<LngLatBounds | undefined>(() => {
    const heros = city.heroIncidents ?? [];
    if (heros.length === 0) return undefined;
    const lngs = heros.map((h) => h.lng);
    const lats = heros.map((h) => h.lat);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const padLng = Math.max((maxLng - minLng) * 0.25, 0.005);
    const padLat = Math.max((maxLat - minLat) * 0.25, 0.004);
    return [
      [minLng - padLng, minLat - padLat],
      [maxLng + padLng, maxLat + padLat],
    ];
  }, [city]);

  const uniqueWatches = useMemo(
    () => Array.from(new Set(events.map((e) => e.keyword))),
    [events],
  );
  const matchedKeywordIndex = uniqueWatches.indexOf(events[idx].keyword);

  return (
    <section
      id="newsroom"
      className="lp-persona-section lp-newsroom-section"
      aria-label="Newsroom keyword alerts demo"
    >
      <div className="lp-route-section-inner">
        <header className="lp-route-section-head">
          <div
            className="lp-hero-channel lp-hero-channel--compact lp-route-section-eyebrow"
            role="status"
            aria-label="Newsroom keyword alerts"
          >
            <span className="lp-hero-channel__pulse" aria-hidden="true" />
            <p className="lp-hero-channel__line" style={{ margin: 0 }}>
              Newsroom &middot; keyword watches
              <span className="lp-route-section-pro">Pro</span>
            </p>
          </div>
          <h2 className="lp-route-section-title">
            Pinged the moment a story breaks.
          </h2>
          <p className="lp-route-section-sub">
            Set a watch for the phrases you care about &mdash; &ldquo;shots
            fired&rdquo;, &ldquo;structure fire&rdquo;, &ldquo;officer
            down&rdquo;. When a public incident report matches, you get a push
            alert with a summary and a deep link to the map.
          </p>
        </header>

        <div className="lp-route-section-grid">
          <div className="lp-route-canvas-wrap">
            <CityMapCanvas
              className="lp-route-map"
              city={city}
              zoom={12.4}
              pitch={20}
              bearing={-8}
              drift={false}
              bounds={bounds}
              boundsPadding={56}
              onReady={handleMapReady}
            />
            <NewsroomCanvas
              className="lp-route-overlay"
              city={city}
              map={map}
              events={events}
              activeEventIndex={idx}
              accentRgb={accentRgb}
            />
          </div>

          <div className="lp-route-picker-wrap">
            <NewsroomInbox
              events={events}
              firingIndex={idx}
              matchedKeywordIndex={matchedKeywordIndex}
              accentRgb={accentRgb}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
