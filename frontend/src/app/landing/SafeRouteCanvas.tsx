"use client";

/**
 * SafeRouteCanvas
 *
 * Overlay layered on top of the safer-route minimap. All geometry is
 * authored in lng/lat (see RouteDemoPair in pulse-cities.ts), then
 * projected through the live MapLibre instance every frame so the red
 * "fastest" route, the green "safer" detour, the hot-zone disc, and
 * the gun/knife blips stay glued to actual streets even while the
 * camera drifts and rotates underneath.
 *
 * Composition:
 *   - <canvas> for the routes + hot-zone gradient (procedural geometry,
 *     re-projected on every map render).
 *   - maplibregl.Marker DOM elements for the from/to endpoints and
 *     each gun/knife blip (anchored automatically).
 */

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { PulseCity, RouteDemoPair } from "@/lib/pulse-cities";
import {
  createBlipElement,
  createEndpointElement,
} from "./landing-glyphs";

const RED = "239, 68, 68";
const GREEN = "34, 197, 94";

/** Sample a cubic bezier defined in lng/lat into N points (still lng/lat). */
function sampleCubicLngLat(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  n = 80,
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const q = 1 - t;
    const x =
      q * q * q * p0[0] +
      3 * q * q * t * p1[0] +
      3 * q * t * t * p2[0] +
      t * t * t * p3[0];
    const y =
      q * q * q * p0[1] +
      3 * q * q * t * p1[1] +
      3 * q * t * t * p2[1] +
      t * t * t * p3[1];
    pts.push([x, y]);
  }
  return pts;
}

/** Build the two route polylines (in lng/lat) for one demo pair. */
function buildRoutes(pair: RouteDemoPair): {
  red: [number, number][];
  green: [number, number][];
} {
  const [fx, fy] = pair.fromLngLat;
  const [tx, ty] = pair.toLngLat;
  const [hx, hy] = pair.hotLngLat;

  // Red "fastest" — bows slightly toward the hot zone so it visually
  // crosses through the violent-crime cluster.
  const red = sampleCubicLngLat(
    pair.fromLngLat,
    [hx + (fx - hx) * 0.4, hy + (fy - hy) * 0.4],
    [hx + (tx - hx) * 0.4, hy + (ty - hy) * 0.4],
    pair.toLngLat,
    80,
  );

  // Green "safer" — detour perpendicular to the from→to axis, pushed
  // *away* from the hot-zone center.
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const midAx = (fx + tx) / 2;
  const midAy = (fy + ty) / 2;
  const sign = (hx - midAx) * nx + (hy - midAy) * ny > 0 ? -1 : 1;
  // Perpendicular offset in degrees. Scaled to the route length so the
  // detour reads as ~25% of the diagonal.
  const offMag = len * 0.55 * sign;
  const offX = nx * offMag;
  const offY = ny * offMag;
  const green = sampleCubicLngLat(
    pair.fromLngLat,
    [fx + dx * 0.25 + offX, fy + dy * 0.25 + offY],
    [fx + dx * 0.75 + offX, fy + dy * 0.75 + offY],
    pair.toLngLat,
    80,
  );

  return { red, green };
}

interface Props {
  className?: string;
  city: PulseCity;
  /** The MapLibre map instance to project through. */
  map: maplibregl.Map | null;
  /** Index into city.routeDemoPairs. */
  activePairIndex: number;
}

export function SafeRouteCanvas({
  className,
  city,
  map,
  activePairIndex,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /* ── Endpoint + blip markers (anchored, follow the map) ────────── */
  useEffect(() => {
    if (!map) return;
    const pair = city.routeDemoPairs[activePairIndex];
    if (!pair) return;

    const markers: maplibregl.Marker[] = [];

    const fromEl = createEndpointElement("start");
    markers.push(
      new maplibregl.Marker({ element: fromEl, anchor: "center" })
        .setLngLat(pair.fromLngLat)
        .addTo(map),
    );

    const toEl = createEndpointElement("end");
    markers.push(
      new maplibregl.Marker({ element: toEl, anchor: "center" })
        .setLngLat(pair.toLngLat)
        .addTo(map),
    );

    for (const b of pair.blips) {
      const el = createBlipElement({
        kind: b.kind,
        size: 22,
        extraClassName: "lp-blip--route",
      });
      el.style.animationDelay = `${(Math.random() * 1.6).toFixed(2)}s`;
      markers.push(
        new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([b.lng, b.lat])
          .addTo(map),
      );
    }

    return () => {
      for (const m of markers) m.remove();
    };
  }, [map, city, activePairIndex]);

  /* ── Routes + hot-zone canvas (re-projected every frame) ───────── */
  useEffect(() => {
    if (!map) return;
    const pair = city.routeDemoPairs[activePairIndex];
    if (!pair) return;

    const cvs = canvasRef.current!;
    const ctx = cvs.getContext("2d")!;
    const dpr = devicePixelRatio || 1;
    let w = 0;
    let h = 0;
    let raf = 0;
    let startTs: number | null = null;

    function resize() {
      w = cvs.parentElement!.clientWidth;
      h = cvs.parentElement!.clientHeight;
      cvs.width = w * dpr;
      cvs.height = h * dpr;
      cvs.style.width = `${w}px`;
      cvs.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    addEventListener("resize", resize);

    const { red: redLngLat, green: greenLngLat } = buildRoutes(pair);

    function projectAll(pts: [number, number][]): [number, number][] {
      return pts.map((p) => {
        const px = map!.project(p as maplibregl.LngLatLike);
        return [px.x, px.y];
      });
    }

    function drawPath(
      pts: [number, number][],
      progress: number,
      rgb: string,
      alpha: number,
      width: number,
    ) {
      if (progress <= 0) return;
      const count = Math.max(2, Math.floor(pts.length * progress));

      // Glow underlay.
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = width + 6;
      ctx.strokeStyle = `rgba(${rgb}, ${alpha * 0.22})`;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const [x, y] = pts[i];
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Crisp stroke.
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const [x, y] = pts[i];
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    function draw(t: number) {
      if (startTs === null) startTs = t;
      const elapsed = (t - startTs) / 1000;
      ctx.clearRect(0, 0, w, h);

      const redPx = projectAll(redLngLat);
      const greenPx = projectAll(greenLngLat);
      const hotPx = map!.project(pair!.hotLngLat as maplibregl.LngLatLike);

      // ── Hot-zone disc (pulsing) ──
      const hotPulse = (Math.sin(t * 0.0032) + 1) / 2;
      const hr = Math.min(w, h) * (0.16 + hotPulse * 0.02);
      const hotGrad = ctx.createRadialGradient(hotPx.x, hotPx.y, 0, hotPx.x, hotPx.y, hr);
      hotGrad.addColorStop(0, `rgba(${RED}, ${0.3 + hotPulse * 0.1})`);
      hotGrad.addColorStop(0.6, `rgba(${RED}, ${0.12 + hotPulse * 0.05})`);
      hotGrad.addColorStop(1, `rgba(${RED}, 0)`);
      ctx.fillStyle = hotGrad;
      ctx.beginPath();
      ctx.arc(hotPx.x, hotPx.y, hr, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(${RED}, ${0.38 + hotPulse * 0.22})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(hotPx.x, hotPx.y, hr * 0.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── Routes ──
      const redProg = Math.max(0, Math.min(1, elapsed / 1.6));
      const greenProg = Math.max(0, Math.min(1, (elapsed - 0.6) / 1.8));
      drawPath(redPx, redProg, RED, 0.85, 3.5);
      drawPath(greenPx, greenProg, GREEN, 0.95, 4);

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return () => {
      removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, [map, city, activePairIndex]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
