"use client";

/**
 * Per-row incident thumbnail used in the full-screen `/feed`.
 *
 * Renders a small map preview for an incident by stitching 2×2 OSM
 * raster tiles from CARTO. See `lib/static-map.ts` for the rationale
 * (TL;DR: the same tiles the main map uses are already cached by the
 * service worker, so this is essentially free for repeat scrollers
 * and uses zero new third-party API budget).
 *
 * Quality-of-life details:
 *   - IntersectionObserver-gated: tiles aren't requested until the
 *     row scrolls within ~200px of the viewport. A 100-row feed scrolled
 *     halfway down therefore costs ~half the requests, not all of them.
 *   - `loading="lazy"` + `decoding="async"` are belt-and-suspenders for
 *     browsers that don't honour our IO-gate (or that pre-fetch images
 *     above the viewport heuristically).
 *   - The container always renders a colored placeholder + the marker
 *     pin even before tiles arrive, so a slow network leaves the row
 *     legible (you still see "where" via the row's `location_text`).
 *   - We deliberately reuse the same tile URL pattern Leaflet uses on
 *     the main map. Cache keys match → maximum SW-cache hit rate.
 */

import { useEffect, useRef, useState } from "react";
import { planStaticMap, type StaticMapVariant } from "@/lib/static-map";

interface Props {
  lat: number;
  lng: number;
  width?: number;
  height?: number;
  zoom?: number;
  /**
   * Color for the marker dot painted on top of the tile. Wire this
   * to the row's severity color so the thumbnail visually echoes the
   * row's category accent.
   */
  markerColor?: string;
  variant?: StaticMapVariant;
  className?: string;
  /** Forwarded to the wrapping div for extra style overrides. */
  style?: React.CSSProperties;
}

export default function IncidentThumbnail({
  lat,
  lng,
  width = 110,
  height = 72,
  zoom = 15,
  markerColor = "#ef4444",
  variant = "dark",
  className,
  style,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      // Without IO support we just give up on lazy loading — better
      // to show the thumbnail than to silently never show it.
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true);
            obs.disconnect();
            return;
          }
        }
      },
      { rootMargin: "200px 0px" }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [visible]);

  const plan = planStaticMap(lat, lng, zoom, variant);
  // Translate the stitched canvas so the marker pixel lands at the
  // visual center of our viewport box.
  const offsetX = -plan.markerX + width / 2;
  const offsetY = -plan.markerY + height / 2;

  const placeholderBg = variant === "light" ? "#e5e7eb" : "#1f2937";

  return (
    <div
      ref={containerRef}
      className={className}
      aria-hidden="true"
      style={{
        position: "relative",
        width,
        height,
        overflow: "hidden",
        background: placeholderBg,
        borderRadius: 8,
        flexShrink: 0,
        ...style,
      }}
    >
      {visible && (
        <div
          style={{
            position: "absolute",
            left: offsetX,
            top: offsetY,
            width: plan.canvasWidth,
            height: plan.canvasHeight,
            pointerEvents: "none",
          }}
        >
          {plan.tiles.map((t) => (
            <img
              key={`${t.gx}-${t.gy}-${t.url}`}
              src={t.url}
              alt=""
              loading="lazy"
              decoding="async"
              width={256}
              height={256}
              draggable={false}
              referrerPolicy="no-referrer"
              style={{
                position: "absolute",
                left: t.gx * 256,
                top: t.gy * 256,
                pointerEvents: "none",
                userSelect: "none",
              }}
              onError={(e) => {
                // CARTO blips happen — fade the broken tile so the
                // adjacent good tiles + the marker still tell the
                // user where the incident is.
                const img = e.currentTarget as HTMLImageElement;
                img.style.opacity = "0";
              }}
            />
          ))}
        </div>
      )}

      {/* Marker pin painted on top of (and persisted across) the
       * tile load lifecycle — there's always *something* anchored
       * at the viewport center so the row reads as "a place" even
       * before any tile arrives. */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 7,
          top: height / 2 - 7,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: markerColor,
          border: "2px solid white",
          boxShadow: `0 1px 4px rgba(0,0,0,0.6), 0 0 8px ${markerColor}66`,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
