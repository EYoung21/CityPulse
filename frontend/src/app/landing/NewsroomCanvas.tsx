"use client";

/**
 * NewsroomCanvas
 *
 * Overlay layered on top of the newsroom-section minimap. Two visual
 * elements:
 *   1. A "scanner ticker" rail along the top of the canvas that scrolls
 *      a chatter stream of generic phrases — when a keyword from the
 *      active event scrolls through, it visibly highlights.
 *   2. Pulse-ring markers at each heroIncidents lng/lat. The marker for
 *      the active event pulses brighter and emits a fresh wave.
 *
 * The parent NewsroomSection drives `activeEventIndex` on a cycle; the
 * canvas reacts by re-creating the active marker (which re-triggers its
 * keyframe-driven CSS pulse from t=0).
 */

import { useEffect, useMemo, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { PulseCity } from "@/lib/pulse-cities";
import type { NewsroomEvent } from "./newsroom-events";

interface Props {
  className?: string;
  city: PulseCity;
  map: maplibregl.Map | null;
  events: NewsroomEvent[];
  activeEventIndex: number;
  accentRgb: string;
}

const TICKER_CHATTER = [
  "Unit 12 responding",
  "Copy that, en route",
  "Traffic stop, plate Adam Boy Charles",
  "Stand by for description",
  "All units, hold the air",
  "Suspect on foot, southbound",
  "Subject in custody, code 4",
  "Be advised, witnesses on scene",
  "Reduce speed, weather alert",
  "Dispatch, requesting backup",
];

function pulseMarkerEl(opts: {
  accentRgb: string;
  hot: boolean;
}) {
  const wrap = document.createElement("div");
  wrap.className = `lp-newsroom-pulse ${opts.hot ? "is-hot" : ""}`;
  wrap.style.setProperty("--accent-rgb", opts.accentRgb);
  wrap.innerHTML = `
    <span class="lp-newsroom-pulse-ring"></span>
    <span class="lp-newsroom-pulse-ring lp-newsroom-pulse-ring--2"></span>
    <span class="lp-newsroom-pulse-core"></span>
  `;
  return wrap;
}

export function NewsroomCanvas({
  className,
  city,
  map,
  events,
  activeEventIndex,
  accentRgb,
}: Props) {
  const tickerRef = useRef<HTMLDivElement>(null);

  const heroLocs = useMemo(
    () =>
      (city.heroIncidents ?? [])
        .filter((h) => Number.isFinite(h.lng) && Number.isFinite(h.lat))
        .map((h) => ({ lng: h.lng, lat: h.lat })),
    [city],
  );

  const activeEvent = events[activeEventIndex];
  const activeLocIdx = activeEvent
    ? activeEvent.heroIndex % Math.max(heroLocs.length, 1)
    : 0;

  /* ── Map pulse markers ────────────────────────────────────────── */
  useEffect(() => {
    if (!map || heroLocs.length === 0) return;
    const markers: maplibregl.Marker[] = [];

    heroLocs.forEach((loc, i) => {
      const el = pulseMarkerEl({
        accentRgb,
        hot: i === activeLocIdx,
      });
      markers.push(
        new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([loc.lng, loc.lat])
          .addTo(map),
      );
    });

    return () => {
      for (const m of markers) m.remove();
    };
    // Re-create markers whenever the active location changes so the
    // CSS keyframe pulse restarts from t=0 on the newly hot one.
  }, [map, heroLocs, activeLocIdx, accentRgb]);

  /* ── Ticker: blend the active keyword into the chatter ────────── */
  const tickerItems = useMemo(() => {
    if (!activeEvent) return TICKER_CHATTER;
    const merged: { text: string; hot: boolean }[] = [];
    TICKER_CHATTER.forEach((t, i) => {
      merged.push({ text: t, hot: false });
      if (i === 2) merged.push({ text: activeEvent.keyword, hot: true });
    });
    return merged.map((m) => (typeof m === "string" ? { text: m, hot: false } : m));
  }, [activeEvent]);

  return (
    <div className={className} aria-hidden="true">
      <div className="lp-newsroom-ticker" ref={tickerRef}>
        <div className="lp-newsroom-ticker-track">
          {[...tickerItems, ...tickerItems].map((item, i) => {
            const ti = item as { text: string; hot: boolean };
            return (
              <span
                key={`${ti.text}-${i}-${activeEventIndex}`}
                className={`lp-newsroom-ticker-item ${ti.hot ? "is-hot" : ""}`}
                style={{ "--accent-rgb": accentRgb } as React.CSSProperties}
              >
                <span className="lp-newsroom-ticker-dot" />
                {ti.text}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
