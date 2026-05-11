"use client";

/**
 * SecurityCanvas
 *
 * Visualizes the "event security / venue awareness" pitch as a
 * time-lapse heatmap. Each heroIncidents lng/lat gets a radial-gradient
 * "heat blob" rendered into an HTML canvas projected through MapLibre.
 * Intensity scales with the active time-window index — short window =
 * sparse, recent dots; long window = saturated density. A venue marker
 * sits at the center of the bounding box with a radius ring.
 */

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { PulseCity } from "@/lib/pulse-cities";

interface Props {
  className?: string;
  city: PulseCity;
  map: maplibregl.Map | null;
  /** 0..3 → 1h, 6h, 24h, 3d intensity step. */
  intensityStep: number;
  accentRgb: string;
}

const INTENSITY_BY_STEP = [0.25, 0.55, 0.85, 1.0];
const BLOB_COUNT_BY_STEP = [4, 8, 14, 22];

function venueMarkerEl(accentRgb: string) {
  const wrap = document.createElement("div");
  wrap.className = "lp-security-venue";
  wrap.style.setProperty("--accent-rgb", accentRgb);
  wrap.innerHTML = `
    <span class="lp-security-venue-ring"></span>
    <span class="lp-security-venue-pin"></span>
  `;
  return wrap;
}

export function SecurityCanvas({
  className,
  city,
  map,
  intensityStep,
  accentRgb,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /* Venue marker — center of heroIncidents bbox. */
  useEffect(() => {
    if (!map) return;
    const heros = city.heroIncidents ?? [];
    if (heros.length === 0) return;
    const lngs = heros.map((h) => h.lng);
    const lats = heros.map((h) => h.lat);
    const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;

    const el = venueMarkerEl(accentRgb);
    const m = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat([centerLng, centerLat])
      .addTo(map);
    return () => {
      m.remove();
    };
  }, [map, city, accentRgb]);

  /* Heatmap blobs on a canvas overlay. Re-projected on every map render. */
  useEffect(() => {
    if (!map) return;
    const cvs = canvasRef.current!;
    const ctx = cvs.getContext("2d")!;
    const dpr = devicePixelRatio || 1;

    function resize() {
      const w = map!.getContainer().clientWidth;
      const h = map!.getContainer().clientHeight;
      cvs.width = w * dpr;
      cvs.height = h * dpr;
      cvs.style.width = `${w}px`;
      cvs.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    const heros = city.heroIncidents ?? [];
    if (heros.length === 0) return;
    const lngs = heros.map((h) => h.lng);
    const lats = heros.map((h) => h.lat);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    /* Synthesize extra blobs jittered around the heros so the heatmap
       reads as a density field rather than 3-4 discrete dots. The count
       scales with the active time-window step. */
    const seed = (i: number) =>
      ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
    const blobCount = BLOB_COUNT_BY_STEP[intensityStep] ?? 6;
    const intensity = INTENSITY_BY_STEP[intensityStep] ?? 0.5;
    const points: { lng: number; lat: number; weight: number }[] = [];
    for (let i = 0; i < blobCount; i++) {
      // Distribute by hero anchor, jitter around it deterministically.
      const anchor = heros[i % heros.length];
      const jLng = (seed(i * 2.1) - 0.5) * (maxLng - minLng) * 0.4;
      const jLat = (seed(i * 3.7) - 0.5) * (maxLat - minLat) * 0.4;
      points.push({
        lng: anchor.lng + jLng,
        lat: anchor.lat + jLat,
        weight: 0.4 + seed(i * 5.3) * 0.6,
      });
    }

    function draw() {
      const w = cvs.width / dpr;
      const h = cvs.height / dpr;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      for (const p of points) {
        const pt = map!.project([p.lng, p.lat]);
        const radius = 38 * (0.7 + p.weight * 0.6);
        const alpha = intensity * (0.18 + p.weight * 0.4);
        const grad = ctx.createRadialGradient(
          pt.x,
          pt.y,
          1,
          pt.x,
          pt.y,
          radius,
        );
        grad.addColorStop(0, `rgba(${accentRgb}, ${alpha})`);
        grad.addColorStop(0.5, `rgba(${accentRgb}, ${alpha * 0.4})`);
        grad.addColorStop(1, `rgba(${accentRgb}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    }

    draw();
    map.on("render", draw);
    map.on("move", draw);
    map.on("resize", resize);

    return () => {
      map.off("render", draw);
      map.off("move", draw);
      map.off("resize", resize);
    };
  }, [map, city, intensityStep, accentRgb]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
