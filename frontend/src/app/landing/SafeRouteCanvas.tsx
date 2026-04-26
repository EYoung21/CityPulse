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
  createRouteVerdictElement,
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

/** Sample a Catmull–Rom spline through waypoints (lng/lat) into points. */
function sampleCatmullRomLngLat(
  pts: [number, number][],
  samplesPerSegment = 28,
): [number, number][] {
  if (pts.length <= 2) return pts.slice();
  const out: [number, number][] = [];
  const n = pts.length;
  const get = (i: number) => pts[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    for (let s = 0; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      if (out.length === 0) out.push([x, y]);
      else {
        const [lx, ly] = out[out.length - 1];
        if (Math.hypot(x - lx, y - ly) > 1e-6) out.push([x, y]);
      }
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function midpointOnPolylineLngLat(poly: [number, number][]): [number, number] {
  if (poly.length === 0) return [0, 0];
  if (poly.length === 1) return poly[0];
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    total += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  }
  const half = total / 2;
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    if (acc + seg >= half) {
      const t = (half - acc) / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    acc += seg;
  }
  return poly[poly.length - 1];
}

/** Build a "slalom" green route that visibly weaves around each blip. */
function buildSlalomGreenRoute(pair: RouteDemoPair): [number, number][] {
  const [fx, fy] = pair.fromLngLat;
  const [tx, ty] = pair.toLngLat;
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;

  const midAx = (fx + tx) / 2;
  const midAy = (fy + ty) / 2;
  const [hx, hy] = pair.hotLngLat;
  // Choose which side "away from hot zone" is, then alternate around it.
  const baseSign = (hx - midAx) * nx + (hy - midAy) * ny > 0 ? -1 : 1;

  const blips = [...(pair.blips ?? [])]
    .map((b) => {
      const bx = b.lng;
      const by = b.lat;
      const t = (bx - fx) * ux + (by - fy) * uy; // projection along from->to axis
      return { bx, by, t };
    })
    .sort((a, b) => a.t - b.t);

  // Offset magnitude tuned so it reads like "around cones" but stays local.
  const offBase = clamp(len * 0.14, 0.0016, 0.0065);

  const waypoints: [number, number][] = [[fx, fy]];
  for (let i = 0; i < blips.length; i++) {
    const b = blips[i];
    // Alternate sides each blip, but bias overall to avoid the hot zone.
    const side = baseSign * (i % 2 === 0 ? 1 : -1);
    // Strength scales with proximity to the corridor center.
    const frac = clamp(b.t / len, 0.1, 0.9);
    const strength = 0.75 + 0.35 * Math.sin(frac * Math.PI);
    const off = offBase * strength * side;
    // Place the waypoint slightly "ahead" of the blip along the path
    // so the curve visibly bends around it.
    const ahead = clamp(len * 0.03, 0.0008, 0.0025);
    waypoints.push([b.bx + ux * ahead + nx * off, b.by + uy * ahead + ny * off]);
  }
  waypoints.push([tx, ty]);

  return sampleCatmullRomLngLat(waypoints, 26);
}

/**
 * Analytical midpoints (t=0.5) of the same red/green bezier curves
 * built by buildRoutes(). We compute these instead of pulling pts[40]
 * from the sampled polyline so the verdict markers can be positioned
 * before the canvas effect runs.
 */
function midpointsLngLat(pair: RouteDemoPair): {
  redMid: [number, number];
  greenMid: [number, number];
} {
  const [fx, fy] = pair.fromLngLat;
  const [tx, ty] = pair.toLngLat;
  const [hx, hy] = pair.hotLngLat;

  const cubicAt = (
    p0: [number, number],
    p1: [number, number],
    p2: [number, number],
    p3: [number, number],
    t: number,
  ): [number, number] => {
    const q = 1 - t;
    return [
      q * q * q * p0[0] +
        3 * q * q * t * p1[0] +
        3 * q * t * t * p2[0] +
        t * t * t * p3[0],
      q * q * q * p0[1] +
        3 * q * q * t * p1[1] +
        3 * q * t * t * p2[1] +
        t * t * t * p3[1],
    ];
  };

  const redMid = cubicAt(
    pair.fromLngLat,
    [hx + (fx - hx) * 0.4, hy + (fy - hy) * 0.4],
    [hx + (tx - hx) * 0.4, hy + (ty - hy) * 0.4],
    pair.toLngLat,
    0.5,
  );

  // Green midpoint should follow the actual "slalom" polyline midpoint
  // so the checkmark always sits on the visible curve.
  const greenMid = midpointOnPolylineLngLat(buildSlalomGreenRoute(pair));

  return { redMid, greenMid };
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

  // Green "safer" — slalom around each incident blip, like cones.
  const green = buildSlalomGreenRoute(pair);

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
    const pair = city.routeDemoPairs?.[activePairIndex];
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

    // Verdict badges at each route's midpoint. We use the lng/lat
    // bezier midpoint (computed analytically at t=0.5 from the same
    // control points used in buildRoutes) so the badge sits exactly on
    // the drawn line. Fade-in delays are tuned to match the canvas
    // route animation so the badge appears as the line finishes.
    const { redMid, greenMid } = midpointsLngLat(pair);

    const xEl = createRouteVerdictElement("bad");
    xEl.style.setProperty("--lp-verdict-delay", "1.55s");
    markers.push(
      new maplibregl.Marker({ element: xEl, anchor: "center" })
        .setLngLat(redMid)
        .addTo(map),
    );

    const checkEl = createRouteVerdictElement("good");
    checkEl.style.setProperty("--lp-verdict-delay", "2.5s");
    markers.push(
      new maplibregl.Marker({ element: checkEl, anchor: "center" })
        .setLngLat(greenMid)
        .addTo(map),
    );

    return () => {
      for (const m of markers) m.remove();
    };
  }, [map, city, activePairIndex]);

  /* ── Routes + hot-zone canvas (re-projected every frame) ───────── */
  useEffect(() => {
    if (!map) return;
    const pair = city.routeDemoPairs?.[activePairIndex];
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
    const ro = new ResizeObserver(resize);
    if (cvs.parentElement) ro.observe(cvs.parentElement);

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
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [map, city, activePairIndex]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
