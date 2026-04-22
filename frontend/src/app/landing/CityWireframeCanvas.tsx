"use client";

/**
 * CityWireframeCanvas
 *
 * Procedurally renders a city-characteristic street grid in an isometric
 * perspective. Each PulseCity has its own `gridStyle` which produces a
 * different pattern (SF diagonals, NYC strict grid, Philly Penn grid,
 * Chattanooga river bend), plus `water` features overlaid.
 *
 * Pure 2D canvas, no webgl, DPR-aware.
 */

import { useEffect, useRef } from "react";
import type { PulseCity, NormPoint } from "@/lib/pulse-cities";

type Segment = [NormPoint, NormPoint];

/** Rotate point (x,y) around origin by angle `a` radians. */
function rot(x: number, y: number, a: number): NormPoint {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/** Generate a rotated grid of line segments in normalized [-0.5..0.5] space. */
function makeGrid(
  cols: number,
  rows: number,
  rotation: number,
  /** How much to extend the grid beyond the visible unit-square, to cover rotation. */
  pad = 0.5,
  /** Random omission probability (for organic irregularity). */
  drop = 0,
): Segment[] {
  const segs: Segment[] = [];
  const x0 = -0.5 - pad, x1 = 0.5 + pad;
  const y0 = -0.5 - pad, y1 = 0.5 + pad;
  const stepX = (x1 - x0) / cols;
  const stepY = (y1 - y0) / rows;
  // verticals
  for (let i = 0; i <= cols; i++) {
    if (drop && Math.random() < drop) continue;
    const x = x0 + i * stepX;
    segs.push([rot(x, y0, rotation), rot(x, y1, rotation)]);
  }
  // horizontals
  for (let j = 0; j <= rows; j++) {
    if (drop && Math.random() < drop) continue;
    const y = y0 + j * stepY;
    segs.push([rot(x0, y, rotation), rot(x1, y, rotation)]);
  }
  return segs;
}

/** Build city-specific segments in unit square coords [0..1]. */
function buildSegments(style: PulseCity["gridStyle"]): Segment[] {
  const segs: Segment[] = [];

  const recenter = (s: Segment[]): Segment[] =>
    s.map(([[ax, ay], [bx, by]]) => [
      [ax + 0.5, ay + 0.5],
      [bx + 0.5, by + 0.5],
    ]);

  switch (style) {
    case "nyc-manhattan": {
      // Manhattan is rotated ~29° from true north.
      const g = makeGrid(34, 48, (29 * Math.PI) / 180, 0.6);
      segs.push(...recenter(g));
      // Broadway diagonal (cuts across grid at ~10°)
      const bw = rot(-0.8, 0.0, (29 * Math.PI) / 180);
      const be = rot(0.8, 0.05, (29 * Math.PI) / 180);
      segs.push([
        [bw[0] + 0.5, bw[1] + 0.5],
        [be[0] + 0.5, be[1] + 0.5],
      ]);
      break;
    }
    case "sf-diagonal": {
      // Regular north-south grid over most of the city
      const g = makeGrid(28, 28, 0, 0.4);
      segs.push(...recenter(g));
      // Market St & SoMa diagonal — runs at ~37° from horizontal
      const mAng = (37 * Math.PI) / 180;
      const gd = makeGrid(10, 10, mAng, 0.3);
      // Clip to the southeast quadrant (roughly where SoMa lives)
      for (const [[ax, ay], [bx, by]] of gd) {
        if (ax + 0.5 > 0.4 && ax + 0.5 < 1.1 && ay + 0.5 > 0.35) {
          segs.push([
            [ax + 0.5, ay + 0.5],
            [bx + 0.5, by + 0.5],
          ]);
        }
      }
      break;
    }
    case "philly-penn": {
      // William Penn's orthogonal grid — strictly N-S / E-W, no rotation.
      const g = makeGrid(26, 22, 0, 0.3);
      segs.push(...recenter(g));
      break;
    }
    case "chattanooga-bend": {
      // Looser grid with organic irregularities.
      const g = makeGrid(20, 16, (-8 * Math.PI) / 180, 0.4, 0.18);
      segs.push(...recenter(g));
      break;
    }
  }

  return segs;
}

/** Isometric projection: map (x,y) in [0..1] plan-view to canvas px with iso tilt. */
function projectIso(
  x: number,
  y: number,
  w: number,
  h: number,
  /** Tilt factor 0..1: 0 = flat plan view, 1 = dramatic iso. */
  tilt: number,
): [number, number] {
  const cx = w / 2, cy = h * 0.58;
  const planX = (x - 0.5) * w * 0.9;
  const planY = (y - 0.5) * h * 0.9;
  // Isometric: rotate 30° around x-axis (compressing Y), then skew X by depth.
  const py = planY * (1 - tilt * 0.55);
  const px = planX + planY * tilt * 0.3;
  return [cx + px, cy + py];
}

/* ─────────────────────────────────────────────────────────────
   Landmarks — per-city iconic silhouettes drawn as wireframe
   polylines in screen-space (not iso-projected). They sit at
   the horizon and read as distant skyline architecture.
   ───────────────────────────────────────────────────────────── */

type Polyline = [number, number][];

interface LandmarkBundle {
  /** Thin-stroke silhouettes. */
  outlines: Polyline[];
  /** Optional filled polygons (mountain masses, water etc). */
  fills?: Polyline[];
}

/** Quadratic-bezier sampler → returns N points along the curve. */
function sampleQuad(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  n = 16,
): Polyline {
  const pts: Polyline = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const q = 1 - t;
    pts.push([
      q * q * p0[0] + 2 * q * t * p1[0] + t * t * p2[0],
      q * q * p0[1] + 2 * q * t * p1[1] + t * t * p2[1],
    ]);
  }
  return pts;
}

function goldenGateBridge(): LandmarkBundle {
  // Positioned in the upper-left where the bridge actually sits relative
  // to SF. Normalized canvas coords (x right, y down, 0..1).
  const deckY = 0.22;
  const towerTopY = 0.035;
  const xL = 0.05, xM1 = 0.15, xMid = 0.225, xM2 = 0.30, xR = 0.40;

  const outlines: Polyline[] = [];

  // Deck (roadway)
  outlines.push([[xL, deckY], [xR, deckY]]);
  // Second deck line (doubled for visual weight)
  outlines.push([[xL, deckY + 0.006], [xR, deckY + 0.006]]);

  // Two towers as rectangular lattices
  for (const tx of [xM1, xM2]) {
    const hw = 0.008;
    outlines.push([[tx - hw, deckY], [tx - hw, towerTopY]]);
    outlines.push([[tx + hw, deckY], [tx + hw, towerTopY]]);
    // Horizontal crossbars (3)
    for (let k = 1; k <= 3; k++) {
      const y = deckY - (deckY - towerTopY) * (k / 4);
      outlines.push([[tx - hw, y], [tx + hw, y]]);
    }
    // Finial
    outlines.push([[tx - hw, towerTopY], [tx, towerTopY - 0.012]]);
    outlines.push([[tx + hw, towerTopY], [tx, towerTopY - 0.012]]);
  }

  // Main cable — catenary sampled as two quad curves:
  // xL(deck) → up over tower1 → dip to center → up over tower2 → xR(deck)
  const c1 = sampleQuad([xL, deckY], [xM1, towerTopY - 0.008], [xMid, 0.10]);
  const c2 = sampleQuad([xMid, 0.10], [xM2, towerTopY - 0.008], [xR, deckY]);
  outlines.push([...c1, ...c2]);

  // Suspender cables (verticals from deck up to main cable)
  // sample a few between towers
  const total = [...c1, ...c2];
  for (let k = 4; k < total.length; k += 4) {
    const [sx, sy] = total[k];
    if (sx < xM1 - 0.01 || sx > xM2 + 0.01) continue;
    outlines.push([[sx, sy], [sx, deckY]]);
  }

  return { outlines };
}

function empireState(): LandmarkBundle {
  // Central Manhattan skyscraper with setbacks, stepped pyramid top, spire.
  // Positioned right-of-center on the horizon.
  const cx = 0.58;
  const base = 0.22;
  const outlines: Polyline[] = [];

  // Outline: trace up the left side, across the top, down the right.
  const left: Polyline = [
    [cx - 0.025, base],
    [cx - 0.025, 0.16],
    [cx - 0.018, 0.16],
    [cx - 0.018, 0.105],
    [cx - 0.012, 0.105],
    [cx - 0.012, 0.07],
    [cx - 0.006, 0.07],
    [cx - 0.006, 0.042],
    [cx - 0.001, 0.042],
  ];
  const spire: Polyline = [[cx, 0.012]];
  const right: Polyline = [
    [cx + 0.001, 0.042],
    [cx + 0.006, 0.042],
    [cx + 0.006, 0.07],
    [cx + 0.012, 0.07],
    [cx + 0.012, 0.105],
    [cx + 0.018, 0.105],
    [cx + 0.018, 0.16],
    [cx + 0.025, 0.16],
    [cx + 0.025, base],
  ];
  outlines.push([...left, ...spire, ...right]);

  // A few window-row ticks on each setback tier (for wireframe texture)
  const tiers = [
    [cx - 0.024, cx + 0.024, 0.19],
    [cx - 0.024, cx + 0.024, 0.17],
    [cx - 0.017, cx + 0.017, 0.14],
    [cx - 0.017, cx + 0.017, 0.12],
    [cx - 0.011, cx + 0.011, 0.09],
    [cx - 0.005, cx + 0.005, 0.06],
  ];
  for (const [x0, x1, y] of tiers) {
    outlines.push([[x0 as number, y as number], [x1 as number, y as number]]);
  }

  return { outlines };
}

function phillyCityHall(): LandmarkBundle {
  // Iconic Philly: City Hall clock tower with William Penn on top.
  // Centered, the Penn statue is the defining silhouette.
  const cx = 0.5;
  const base = 0.22;
  const outlines: Polyline[] = [];

  // Broad building base (wide)
  outlines.push([
    [cx - 0.09, base],
    [cx - 0.09, 0.19],
    [cx - 0.04, 0.19],
    [cx - 0.04, 0.17],
    [cx + 0.04, 0.17],
    [cx + 0.04, 0.19],
    [cx + 0.09, 0.19],
    [cx + 0.09, base],
  ]);

  // Clock tower rising up from the center
  outlines.push([
    [cx - 0.018, 0.17],
    [cx - 0.018, 0.10],
    [cx - 0.022, 0.10],
    [cx - 0.022, 0.088],
    [cx - 0.015, 0.088],
    [cx - 0.015, 0.064],
  ]);
  outlines.push([
    [cx + 0.018, 0.17],
    [cx + 0.018, 0.10],
    [cx + 0.022, 0.10],
    [cx + 0.022, 0.088],
    [cx + 0.015, 0.088],
    [cx + 0.015, 0.064],
  ]);
  // Clock face band (horizontal at 0.13)
  outlines.push([[cx - 0.018, 0.13], [cx + 0.018, 0.13]]);

  // Pedestal for the statue (narrower block above tower)
  outlines.push([
    [cx - 0.015, 0.064],
    [cx + 0.015, 0.064],
  ]);
  outlines.push([
    [cx - 0.010, 0.064],
    [cx - 0.010, 0.056],
    [cx + 0.010, 0.056],
    [cx + 0.010, 0.064],
  ]);

  // William Penn statue silhouette (tiny, schematic).
  // Famous pose: right arm extended pointing (toward treaty site).
  const penn: Polyline = [
    // feet
    [cx - 0.003, 0.056],
    // body left
    [cx - 0.003, 0.045],
    // shoulder left
    [cx - 0.006, 0.040],
    // head-left → over the top with the famous hat
    [cx - 0.006, 0.036],
    [cx - 0.009, 0.034], // hat brim left
    [cx - 0.009, 0.032], // hat brim corner
    [cx - 0.006, 0.032], // up to hat crown
    [cx - 0.006, 0.028], // top of hat
    [cx + 0.006, 0.028],
    [cx + 0.006, 0.032],
    [cx + 0.009, 0.032],
    [cx + 0.009, 0.034],
    [cx + 0.006, 0.036],
    [cx + 0.006, 0.040],
    // shoulder right (arm point)
    [cx + 0.015, 0.040], // extended arm
    [cx + 0.015, 0.042], // hand
    [cx + 0.006, 0.043], // back to shoulder
    // body right
    [cx + 0.003, 0.045],
    [cx + 0.003, 0.056],
    [cx - 0.003, 0.056],
  ];
  outlines.push(penn);

  return { outlines };
}

function lookoutMountain(): LandmarkBundle {
  // Zigzag ridge across the horizon behind the grid — Lookout & Signal
  // Mountains. Drawn as both a filled polygon mass (dim) AND an outline
  // stroke on top for wireframe feel.
  const ridge: Polyline = [
    [-0.02, 0.20],
    [0.08, 0.17],
    [0.14, 0.15],
    [0.20, 0.13], // first peak (Lookout)
    [0.26, 0.17],
    [0.34, 0.20],
    [0.40, 0.18],
    [0.46, 0.15],
    [0.50, 0.14],
    [0.54, 0.17],
    [0.60, 0.20],
    [0.66, 0.17],
    [0.72, 0.14],
    [0.78, 0.11], // second peak (Signal)
    [0.84, 0.15],
    [0.90, 0.18],
    [1.02, 0.20],
  ];

  // Fill polygon: ridge + close to bottom
  const fill: Polyline = [...ridge, [1.02, 0.30], [-0.02, 0.30]];

  // Walnut Street Bridge — simple truss across the river.
  // The river in chattanooga.water sits around y=0.38-0.48; place the bridge
  // spanning across at y~0.42, x from 0.42 to 0.62.
  const bridge: Polyline[] = [];
  const by = 0.40, bx0 = 0.44, bx1 = 0.60;
  // Deck
  bridge.push([[bx0, by], [bx1, by]]);
  // Upper chord (arched)
  bridge.push(sampleQuad([bx0, by], [(bx0 + bx1) / 2, by - 0.035], [bx1, by]));
  // Piers
  bridge.push([[bx0, by], [bx0, by + 0.04]]);
  bridge.push([[bx1, by], [bx1, by + 0.04]]);
  // Truss verticals
  for (let k = 1; k < 6; k++) {
    const x = bx0 + ((bx1 - bx0) * k) / 6;
    const t = k / 6;
    const q = 1 - t;
    const archY = q * q * by + 2 * q * t * (by - 0.035) + t * t * by;
    bridge.push([[x, archY], [x, by]]);
  }

  return { outlines: [ridge, ...bridge], fills: [fill] };
}

function buildLandmarks(style: PulseCity["gridStyle"]): LandmarkBundle {
  switch (style) {
    case "sf-diagonal":
      return goldenGateBridge();
    case "nyc-manhattan":
      return empireState();
    case "philly-penn":
      return phillyCityHall();
    case "chattanooga-bend":
      return lookoutMountain();
  }
}

interface Props {
  className: string;
  city: PulseCity;
}

export function CityWireframeCanvas({ className, city }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cvs = ref.current!;
    const ctx = cvs.getContext("2d")!;
    const dpr = devicePixelRatio || 1;
    let w = 0, h = 0, raf = 0;

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
    const landmarks = buildLandmarks(city.gridStyle);
    const accent = city.accentRgb;
    const accent2 = city.accentRgb2;

    // Pre-generate a handful of "incident" markers — drifting dots on the grid.
    const markers = Array.from({ length: 14 }, (_, i) => ({
      x: Math.random(),
      y: Math.random(),
      phase: Math.random() * Math.PI * 2,
      hot: i < 3, // a few hot incidents pulse harder
    }));

    // Floating particles
    const pts = Array.from({ length: 36 }, () => ({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00025,
      vy: (Math.random() - 0.5) * 0.00025,
      a: Math.random() * 0.18 + 0.04,
      s: Math.random() * 1.2 + 0.4,
    }));

    const TILT = 0.5;

    function draw(t: number) {
      ctx.clearRect(0, 0, w, h);

      // Slow parallax drift: entire scene shifts a pixel or two.
      const drift = Math.sin(t * 0.00015) * 6;
      ctx.save();
      ctx.translate(drift, Math.cos(t * 0.0002) * 4);

      // ── Water features (behind grid) ──
      for (const wf of city.water) {
        if (wf.filled) {
          ctx.fillStyle = `rgba(40, 90, 140, 0.18)`;
          ctx.beginPath();
          wf.path.forEach(([x, y], i) => {
            const [px, py] = projectIso(x, y, w, h, TILT);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.closePath();
          ctx.fill();
          // subtle inner glow ripple
          ctx.strokeStyle = `rgba(80, 160, 220, 0.12)`;
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          ctx.strokeStyle = `rgba(80, 160, 220, 0.22)`;
          ctx.lineWidth = Math.max(1.5, (wf.width ?? 0.03) * Math.min(w, h) * 0.5);
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          wf.path.forEach(([x, y], i) => {
            const [px, py] = projectIso(x, y, w, h, TILT);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.stroke();

          // Flow particles along the river
          const flow = (t * 0.00008) % 1;
          for (let i = 0; i < 3; i++) {
            const f = (flow + i / 3) % 1;
            const idx = Math.min(
              wf.path.length - 2,
              Math.floor(f * (wf.path.length - 1)),
            );
            const local = f * (wf.path.length - 1) - idx;
            const [ax, ay] = wf.path[idx];
            const [bx, by] = wf.path[idx + 1];
            const x = ax + (bx - ax) * local;
            const y = ay + (by - ay) * local;
            const [px, py] = projectIso(x, y, w, h, TILT);
            ctx.fillStyle = `rgba(140, 200, 240, 0.5)`;
            ctx.beginPath();
            ctx.arc(px, py, 1.8, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // ── Street grid ──
      ctx.lineWidth = 1;
      for (const [[ax, ay], [bx, by]] of segments) {
        // Clip to roughly visible unit square
        if (
          (ax < -0.1 && bx < -0.1) ||
          (ax > 1.1 && bx > 1.1) ||
          (ay < -0.1 && by < -0.1) ||
          (ay > 1.1 && by > 1.1)
        ) continue;
        const [px1, py1] = projectIso(ax, ay, w, h, TILT);
        const [px2, py2] = projectIso(bx, by, w, h, TILT);
        // Fade toward horizon (top)
        const midY = (py1 + py2) / 2;
        const fade = Math.max(0, Math.min(1, (midY - h * 0.1) / (h * 0.6)));
        ctx.strokeStyle = `rgba(${accent}, ${0.035 + fade * 0.07})`;
        ctx.beginPath();
        ctx.moveTo(px1, py1);
        ctx.lineTo(px2, py2);
        ctx.stroke();
      }

      // Brighter "main streets" — scanning beam that travels across.
      const scanX = (t * 0.00018) % 1;
      for (const [[ax, ay], [bx, by]] of segments) {
        const midX = (ax + bx) / 2;
        const dist = Math.abs(midX - scanX);
        if (dist > 0.08) continue;
        const glow = 1 - dist / 0.08;
        const [px1, py1] = projectIso(ax, ay, w, h, TILT);
        const [px2, py2] = projectIso(bx, by, w, h, TILT);
        ctx.strokeStyle = `rgba(${accent2}, ${glow * 0.35})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px1, py1);
        ctx.lineTo(px2, py2);
        ctx.stroke();
      }
      ctx.lineWidth = 1;

      // ── Landmark silhouettes (screen-space, not iso-projected) ──
      // Subtle breathing glow so the landmark feels "alive".
      const lmPulse = (Math.sin(t * 0.0009) + 1) / 2; // 0..1
      // Fills (mountain mass etc) — dim, behind outlines
      if (landmarks.fills) {
        for (const fill of landmarks.fills) {
          ctx.fillStyle = `rgba(${accent}, 0.035)`;
          ctx.beginPath();
          fill.forEach(([x, y], i) => {
            const px = x * w, py = y * h;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.closePath();
          ctx.fill();
        }
      }
      // Outlines
      ctx.lineWidth = 1;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (const line of landmarks.outlines) {
        if (line.length < 2) continue;
        ctx.strokeStyle = `rgba(${accent2}, ${0.35 + lmPulse * 0.15})`;
        ctx.beginPath();
        line.forEach(([x, y], i) => {
          const px = x * w, py = y * h;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
      // Soft halo behind landmark (accent glow)
      {
        // approximate landmark centroid: average of first outline's points
        const first = landmarks.outlines[0];
        if (first && first.length > 0) {
          let sx = 0, sy = 0;
          for (const [x, y] of first) { sx += x; sy += y; }
          const cxL = (sx / first.length) * w;
          const cyL = (sy / first.length) * h;
          const rG = Math.min(w, h) * 0.2;
          const halo = ctx.createRadialGradient(cxL, cyL, 0, cxL, cyL, rG);
          halo.addColorStop(0, `rgba(${accent}, ${0.08 + lmPulse * 0.04})`);
          halo.addColorStop(1, `rgba(${accent}, 0)`);
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(cxL, cyL, rG, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // ── Incident markers (drift & pulse) ──
      markers.forEach((m, i) => {
        const [px, py] = projectIso(m.x, m.y, w, h, TILT);
        const pulse = (Math.sin(t * 0.0022 + m.phase) + 1) / 2;
        const r = m.hot ? 3 + pulse * 5 : 2 + pulse * 2;
        const a = m.hot ? 0.6 + pulse * 0.3 : 0.35 + pulse * 0.25;
        // Outer ring for hot
        if (m.hot) {
          ctx.strokeStyle = `rgba(${accent}, ${0.25 * (1 - pulse)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(px, py, r * 3, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = `rgba(${accent}, ${a})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        void i;
      });

      // ── City center glow + pulsing dot ──
      const [cx, cy] = projectIso(0.5, 0.5, w, h, TILT);
      const gPulse = (Math.sin(t * 0.0015) + 1) / 2;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 140 + gPulse * 30);
      grad.addColorStop(0, `rgba(${accent}, ${0.15 + gPulse * 0.1})`);
      grad.addColorStop(1, `rgba(${accent}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, 140 + gPulse * 30, 0, Math.PI * 2);
      ctx.fill();
      // center dot
      ctx.fillStyle = `rgba(${accent2}, 0.9)`;
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.fill();

      // ── Floating particles ──
      pts.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > 1) p.vx *= -1;
        if (p.y < 0 || p.y > 1) p.vy *= -1;
        const [px, py] = projectIso(p.x, p.y, w, h, TILT);
        ctx.fillStyle = `rgba(${accent2}, ${p.a})`;
        ctx.beginPath();
        ctx.arc(px, py, p.s, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.restore();

      // Vignette / horizon fade
      const vg = ctx.createLinearGradient(0, 0, 0, h);
      vg.addColorStop(0, "rgba(6, 6, 17, 0.75)");
      vg.addColorStop(0.25, "rgba(6, 6, 17, 0.0)");
      vg.addColorStop(0.85, "rgba(6, 6, 17, 0.0)");
      vg.addColorStop(1, "rgba(6, 6, 17, 0.65)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return () => {
      removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, [city]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
