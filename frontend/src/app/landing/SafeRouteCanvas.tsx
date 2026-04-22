"use client";

/**
 * SafeRouteCanvas
 *
 * A zoomed-in mini version of the CityWireframeCanvas that demonstrates
 * the safer-routing value prop. For each active origin/destination pair
 * we procedurally generate two routes between fixed endpoints:
 *
 *   - a red "fastest" route that cuts straight through a hot-zone
 *   - a green "safer" detour that arcs around the hot-zone
 *
 * Both routes animate in progressively (stroke-dash reveal). The hot-zone
 * pulses with 3 incident blips. When `activePairIndex` changes the scene
 * resets and re-draws.
 */

import { useEffect, useRef } from "react";
import type { PulseCity, NormPoint } from "@/lib/pulse-cities";

type Segment = [NormPoint, NormPoint];

const RED = "239, 68, 68";
const GREEN = "34, 197, 94";

function rot(x: number, y: number, a: number): NormPoint {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/** Simplified grid — coarser than the hero so it reads at small size. */
function makeGrid(cols: number, rows: number, rotation: number, pad = 0.4): Segment[] {
  const segs: Segment[] = [];
  const x0 = -0.5 - pad, x1 = 0.5 + pad;
  const y0 = -0.5 - pad, y1 = 0.5 + pad;
  const stepX = (x1 - x0) / cols;
  const stepY = (y1 - y0) / rows;
  for (let i = 0; i <= cols; i++) {
    const x = x0 + i * stepX;
    segs.push([rot(x, y0, rotation), rot(x, y1, rotation)]);
  }
  for (let j = 0; j <= rows; j++) {
    const y = y0 + j * stepY;
    segs.push([rot(x0, y, rotation), rot(x1, y, rotation)]);
  }
  return segs;
}

function buildSegments(style: PulseCity["gridStyle"]): Segment[] {
  const recenter = (s: Segment[]): Segment[] =>
    s.map(([[ax, ay], [bx, by]]) => [
      [ax + 0.5, ay + 0.5],
      [bx + 0.5, by + 0.5],
    ]);

  switch (style) {
    case "nyc-manhattan":
      return recenter(makeGrid(18, 22, (29 * Math.PI) / 180));
    case "sf-diagonal":
      return recenter(makeGrid(14, 14, 0));
    case "philly-penn":
      return recenter(makeGrid(14, 12, 0));
    case "chattanooga-bend":
      return recenter(makeGrid(12, 10, (-8 * Math.PI) / 180));
  }
}

/** Gentle iso-ish projection. Lower tilt than the hero so routes read clearly. */
function project(x: number, y: number, w: number, h: number): [number, number] {
  const tilt = 0.25;
  const planX = (x - 0.5) * w * 0.92;
  const planY = (y - 0.5) * h * 0.92;
  const py = planY * (1 - tilt * 0.35);
  const px = planX + planY * tilt * 0.2;
  return [w / 2 + px, h * 0.54 + py];
}

/** Sample a cubic bezier into N points in [0..1] canvas space. */
function sampleCubic(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  n = 60,
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const q = 1 - t;
    const x = q * q * q * p0[0] + 3 * q * q * t * p1[0] + 3 * q * t * t * p2[0] + t * t * t * p3[0];
    const y = q * q * q * p0[1] + 3 * q * q * t * p1[1] + 3 * q * t * t * p2[1] + t * t * t * p3[1];
    pts.push([x, y]);
  }
  return pts;
}

interface Pair {
  from: [number, number];
  to: [number, number];
  hot: [number, number];
}

/**
 * Deterministic per-pair endpoint layout. Keeps origin/destination in the
 * lower-left → upper-right band while rotating the exact positions so each
 * cycled pair feels distinct.
 */
function layoutForPair(idx: number): Pair {
  const variants: Pair[] = [
    { from: [0.14, 0.80], to: [0.82, 0.22], hot: [0.48, 0.54] },
    { from: [0.18, 0.28], to: [0.78, 0.80], hot: [0.52, 0.50] },
    { from: [0.20, 0.76], to: [0.80, 0.34], hot: [0.56, 0.58] },
  ];
  return variants[((idx % variants.length) + variants.length) % variants.length];
}

interface Props {
  className?: string;
  city: PulseCity;
  /** Index into city.routeDemoPairs; changes trigger a redraw animation. */
  activePairIndex: number;
}

export function SafeRouteCanvas({ className, city, activePairIndex }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cvs = ref.current!;
    const ctx = cvs.getContext("2d")!;
    const dpr = devicePixelRatio || 1;
    let w = 0, h = 0, raf = 0;
    let startTs: number | null = null;

    function resize() {
      w = cvs.parentElement!.clientWidth;
      h = cvs.parentElement!.clientHeight;
      cvs.width = w * dpr; cvs.height = h * dpr;
      cvs.style.width = `${w}px`; cvs.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    addEventListener("resize", resize);

    const segments = buildSegments(city.gridStyle);
    const accent = city.accentRgb;

    // Per-render geometry (depends on activePairIndex, which is in the
    // dep array so the effect re-runs on change).
    const pair = layoutForPair(activePairIndex);
    const [fx, fy] = pair.from;
    const [tx, ty] = pair.to;
    const [hx, hy] = pair.hot;

    // Direct (red) route: go from from→to, but bowed so it clearly passes
    // through the hot-zone. Cubic bezier with control points biased toward
    // the hot center.
    const redPath = sampleCubic(
      pair.from,
      [hx - 0.02, hy + 0.06],
      [hx + 0.02, hy - 0.06],
      pair.to,
      80,
    );

    // Safer (green) route: detours "above" the hot-zone via a higher arc.
    // Offset perpendicular to the from→to axis.
    const dx = tx - fx, dy = ty - fy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len; // perpendicular
    // Detour offset: push the midpoint outward by ~0.18 in the perpendicular
    // direction chosen to avoid the hot-zone. Pick the sign that points
    // *away* from the hot-zone center.
    const midAx = (fx + tx) / 2, midAy = (fy + ty) / 2;
    const sign = (hx - midAx) * nx + (hy - midAy) * ny > 0 ? -1 : 1;
    const offX = nx * 0.22 * sign;
    const offY = ny * 0.22 * sign;
    const greenPath = sampleCubic(
      pair.from,
      [fx + dx * 0.25 + offX, fy + dy * 0.25 + offY],
      [fx + dx * 0.75 + offX, fy + dy * 0.75 + offY],
      pair.to,
      80,
    );

    // 3 incident blips clustered around the hot-zone.
    const blips = [
      { x: hx - 0.05, y: hy + 0.02, phase: 0.0 },
      { x: hx + 0.04, y: hy - 0.03, phase: 1.7 },
      { x: hx + 0.01, y: hy + 0.05, phase: 3.1 },
    ];

    /** Draw a polyline (in normalized coords) up to `progress` (0..1). */
    function drawPath(
      pts: [number, number][],
      progress: number,
      rgb: string,
      alpha: number,
      width: number,
    ) {
      if (progress <= 0) return;
      const count = Math.max(2, Math.floor(pts.length * progress));
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const [x, y] = pts[i];
        const [px, py] = project(x, y, w, h);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Glow pass
      ctx.lineWidth = width + 5;
      ctx.strokeStyle = `rgba(${rgb}, ${alpha * 0.18})`;
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    function drawEndpoint(
      pt: [number, number],
      rgb: string,
      filled = false,
    ) {
      const [px, py] = project(pt[0], pt[1], w, h);
      ctx.strokeStyle = `rgba(${rgb}, 0.9)`;
      ctx.fillStyle = filled ? `rgba(${rgb}, 0.9)` : "rgba(10, 10, 20, 0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    function draw(t: number) {
      if (startTs === null) startTs = t;
      const elapsed = (t - startTs) / 1000; // seconds
      ctx.clearRect(0, 0, w, h);

      // ── Grid backdrop ──
      for (const [[ax, ay], [bx, by]] of segments) {
        if (
          (ax < -0.1 && bx < -0.1) ||
          (ax > 1.1 && bx > 1.1) ||
          (ay < -0.1 && by < -0.1) ||
          (ay > 1.1 && by > 1.1)
        ) continue;
        const [px1, py1] = project(ax, ay, w, h);
        const [px2, py2] = project(bx, by, w, h);
        const midY = (py1 + py2) / 2;
        const fade = Math.max(0, Math.min(1, (midY - h * 0.1) / (h * 0.6)));
        ctx.strokeStyle = `rgba(${accent}, ${0.04 + fade * 0.06})`;
        ctx.beginPath();
        ctx.moveTo(px1, py1);
        ctx.lineTo(px2, py2);
        ctx.stroke();
      }

      // ── Hot-zone disc (pulsing) ──
      const hotPulse = (Math.sin(t * 0.0032) + 1) / 2;
      const [hcx, hcy] = project(hx, hy, w, h);
      const hr = Math.min(w, h) * (0.16 + hotPulse * 0.02);
      const hotGrad = ctx.createRadialGradient(hcx, hcy, 0, hcx, hcy, hr);
      hotGrad.addColorStop(0, `rgba(${RED}, ${0.28 + hotPulse * 0.1})`);
      hotGrad.addColorStop(0.6, `rgba(${RED}, ${0.1 + hotPulse * 0.05})`);
      hotGrad.addColorStop(1, `rgba(${RED}, 0)`);
      ctx.fillStyle = hotGrad;
      ctx.beginPath();
      ctx.arc(hcx, hcy, hr, 0, Math.PI * 2);
      ctx.fill();
      // Outline ring
      ctx.strokeStyle = `rgba(${RED}, ${0.35 + hotPulse * 0.2})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(hcx, hcy, hr * 0.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── Routes ──
      // Red starts at 0s, reaches full at ~1.6s.
      const redProg = Math.max(0, Math.min(1, elapsed / 1.6));
      // Green starts at 0.6s, reaches full at ~2.4s.
      const greenProg = Math.max(0, Math.min(1, (elapsed - 0.6) / 1.8));

      drawPath(redPath, redProg, RED, 0.75, 3);
      drawPath(greenPath, greenProg, GREEN, 0.9, 3.5);

      // ── Endpoints (drawn on top) ──
      drawEndpoint(pair.from, "255, 255, 255", true);
      drawEndpoint(pair.to, city.accentRgb, true);

      // ── Incident blips (render after routes so they sit on top of red) ──
      for (const b of blips) {
        const [px, py] = project(b.x, b.y, w, h);
        const p = (Math.sin(t * 0.004 + b.phase) + 1) / 2;
        const r = 3 + p * 3;
        // outer pulse ring
        ctx.strokeStyle = `rgba(${RED}, ${0.35 * (1 - p)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, r * 2.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(${RED}, ${0.75 + p * 0.25})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Subtle vignette ──
      const vg = ctx.createLinearGradient(0, 0, 0, h);
      vg.addColorStop(0, "rgba(6, 6, 17, 0.55)");
      vg.addColorStop(0.3, "rgba(6, 6, 17, 0.0)");
      vg.addColorStop(0.85, "rgba(6, 6, 17, 0.0)");
      vg.addColorStop(1, "rgba(6, 6, 17, 0.55)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return () => {
      removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, [city, activePairIndex]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
