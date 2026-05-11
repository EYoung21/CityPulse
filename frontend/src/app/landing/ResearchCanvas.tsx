"use client";

/**
 * ResearchCanvas
 *
 * Drops a pin on the city map for each ResearchRow that has been
 * "loaded" into the feed so far. The parent ResearchSection drives
 * `loadedCount` upward on the cycle; this component adds a marker each
 * tick so the map fills in as the feed populates.
 */

import { useEffect } from "react";
import maplibregl from "maplibre-gl";
import type { PulseCity } from "@/lib/pulse-cities";
import type { ResearchRow } from "./research-rows";

interface Props {
  city: PulseCity;
  map: maplibregl.Map | null;
  rows: ResearchRow[];
  loadedCount: number;
  accentRgb: string;
}

function pinEl(opts: { accentRgb: string; fresh: boolean; label: string }) {
  const wrap = document.createElement("div");
  wrap.className = `lp-research-pin ${opts.fresh ? "is-fresh" : ""}`;
  wrap.style.setProperty("--accent-rgb", opts.accentRgb);
  wrap.innerHTML = `
    <span class="lp-research-pin-core"></span>
    <span class="lp-research-pin-label">${opts.label}</span>
  `;
  return wrap;
}

export function ResearchCanvas({
  city,
  map,
  rows,
  loadedCount,
  accentRgb,
}: Props) {
  useEffect(() => {
    if (!map) return;
    const heros = city.heroIncidents ?? [];
    if (heros.length === 0) return;
    const markers: maplibregl.Marker[] = [];

    const visible = rows.slice(0, loadedCount);
    visible.forEach((row, i) => {
      const loc = heros[row.heroIndex % heros.length];
      // Slight deterministic jitter so duplicate heroIndex rows don't
      // stack exactly on top of each other.
      const jitter = (i * 31) % 7;
      const lng = loc.lng + (jitter - 3) * 0.0006;
      const lat = loc.lat + ((i * 17) % 5 - 2) * 0.0005;
      const el = pinEl({
        accentRgb,
        fresh: i === visible.length - 1,
        label: String(i + 1).padStart(2, "0"),
      });
      markers.push(
        new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([lng, lat])
          .addTo(map),
      );
    });

    return () => {
      for (const m of markers) m.remove();
    };
  }, [map, city, rows, loadedCount, accentRgb]);

  return null;
}
