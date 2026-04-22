"use client";

/**
 * SafeRouteCanvas
 *
 * Overlay canvas layered on top of a CityMapCanvas in the safer-routing
 * demo. Draws only the route geometry — no basemap, no grid, no
 * isometric projection. For each active origin/destination pair we
 * procedurally build two routes:
 *
 *   - a red "fastest" route that cuts straight through a hot-zone
 *   - a green "safer" detour that arcs around it
 *
 * Both routes animate in (stroke-dash reveal), the hot-zone pulses with
 * 3 blinking incident blips, and endpoints are drawn on top. When
 * `activePairIndex` changes, the scene resets and re-animates.
 */

import { useEffect, useRef } from "react";
import type { PulseCity } from "@/lib/pulse-cities";

const RED = "239, 68, 68";
const GREEN = "34, 197, 94";

/** Sample a cubic bezier into N points. Points are in normalized [0..1] space. */
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

interface Pair {
  from: [number, number];
  to: [number, number];
  hot: [number, number];
}

/**
 * Deterministic per-pair endpoint layout. Keeps origin/destination in
 * the lower-left → upper-right band while rotating the exact positions
 * so each cycled pair feels distinct.
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

    const pair = layoutForPair(activePairIndex);
    const [fx, fy] = pair.from;
    const [tx, ty] = pair.to;
    const [hx, hy] = pair.hot;

    // Flat normalized → canvas-pixel projection. A little inset so routes
    // don't kiss the edges of the map behind us.
    const project = (x: number, y: number): [number, number] => {
      const inset = 0.06;
      const px = (inset + x * (1 - inset * 2)) * w;
      const py = (inset + y * (1 - inset * 2)) * h;
      return [px, py];
    };

    // Red "fastest" route bows slightly so it clearly passes *through*
    // the hot-zone.
    const redPath = sampleCubic(
      pair.from,
      [hx - 0.02, hy + 0.06],
      [hx + 0.02, hy - 0.06],
      pair.to,
      80,
    );

    // Green "safer" route: detours perpendicular to the from→to axis,
    // pushing the midpoint away from the hot-zone.
    const dx = tx - fx;
    const dy = ty - fy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const midAx = (fx + tx) / 2;
    const midAy = (fy + ty) / 2;
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

    const blips = [
      { x: hx - 0.05, y: hy + 0.02, phase: 0.0 },
      { x: hx + 0.04, y: hy - 0.03, phase: 1.7 },
      { x: hx + 0.01, y: hy + 0.05, phase: 3.1 },
    ];

    function drawPath(
      pts: [number, number][],
      progress: number,
      rgb: string,
      alpha: number,
      width: number,
    ) {
      if (progress <= 0) return;
      const count = Math.max(2, Math.floor(pts.length * progress));

      // Glow pass first (underneath the crisp stroke).
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = width + 6;
      ctx.strokeStyle = `rgba(${rgb}, ${alpha * 0.22})`;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const [x, y] = pts[i];
        const [px, py] = project(x, y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Crisp stroke on top.
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const [x, y] = pts[i];
        const [px, py] = project(x, y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    function drawEndpoint(pt: [number, number], rgb: string) {
      const [px, py] = project(pt[0], pt[1]);
      ctx.strokeStyle = `rgba(${rgb}, 0.95)`;
      ctx.fillStyle = "rgba(10, 10, 20, 0.95)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    function draw(t: number) {
      if (startTs === null) startTs = t;
      const elapsed = (t - startTs) / 1000;
      ctx.clearRect(0, 0, w, h);

      // ── Hot-zone disc (pulsing) ──
      const hotPulse = (Math.sin(t * 0.0032) + 1) / 2;
      const [hcx, hcy] = project(hx, hy);
      const hr = Math.min(w, h) * (0.16 + hotPulse * 0.02);
      const hotGrad = ctx.createRadialGradient(hcx, hcy, 0, hcx, hcy, hr);
      hotGrad.addColorStop(0, `rgba(${RED}, ${0.3 + hotPulse * 0.1})`);
      hotGrad.addColorStop(0.6, `rgba(${RED}, ${0.12 + hotPulse * 0.05})`);
      hotGrad.addColorStop(1, `rgba(${RED}, 0)`);
      ctx.fillStyle = hotGrad;
      ctx.beginPath();
      ctx.arc(hcx, hcy, hr, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(${RED}, ${0.38 + hotPulse * 0.22})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(hcx, hcy, hr * 0.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── Routes ──
      const redProg = Math.max(0, Math.min(1, elapsed / 1.6));
      const greenProg = Math.max(0, Math.min(1, (elapsed - 0.6) / 1.8));
      drawPath(redPath, redProg, RED, 0.8, 3.25);
      drawPath(greenPath, greenProg, GREEN, 0.92, 3.75);

      // ── Endpoints (on top of routes) ──
      drawEndpoint(pair.from, "255, 255, 255");
      drawEndpoint(pair.to, city.accentRgb);

      // ── Incident blips ──
      for (const b of blips) {
        const [px, py] = project(b.x, b.y);
        const p = (Math.sin(t * 0.004 + b.phase) + 1) / 2;
        const r = 3 + p * 3;
        ctx.strokeStyle = `rgba(${RED}, ${0.4 * (1 - p)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, r * 2.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(${RED}, ${0.8 + p * 0.2})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }

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
