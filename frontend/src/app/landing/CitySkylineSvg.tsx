"use client";

/**
 * CitySkylineSvg
 *
 * Hand-authored SVG skyline silhouettes for each PulseCity. The same
 * component renders two visual variants:
 *
 *   - variant="hero": full-width ribbon pinned at the bottom of the
 *     landing hero, with a soft accent-colored drop shadow.
 *   - variant="card": a compact top-edge accent on each sister-city
 *     card.
 *
 * Colors derive from the current CSS custom property `--accent-rgb`
 * (set per-city on `.landing-page`, or per-card via `--card-accent-rgb`
 * on the `.lp-city-card`). No assets, no external SVG files — keeps
 * everything co-located and tree-shakable.
 */

import type { PulseCity } from "@/lib/pulse-cities";

/** Single-path silhouettes, viewBox 0 0 1200 120. The baseline sits at
 *  y=120 and each path closes back to the bottom-right corner. */
const SKYLINE_PATHS: Record<PulseCity["slug"], string> = {
  sf: `
    M 0 120 L 0 92
    Q 40 72 80 88 Q 120 100 160 95
    L 160 78 L 180 78 L 180 72 L 200 72 L 200 78 L 220 78 L 220 92
    L 240 92 L 240 68 L 290 68 L 290 92
    L 310 92 L 310 50 L 320 50 L 320 32 L 340 32 L 340 50 L 350 50 L 350 92
    L 400 92 L 400 58 L 460 58 L 460 92
    L 500 92 L 500 28 L 510 28 L 510 14 L 520 14 L 520 28 L 530 28 L 530 92
    L 580 92 L 580 70 L 640 70 L 640 92
    L 680 92 L 680 46 L 700 46 L 700 30 L 720 30 L 720 46 L 740 46 L 740 92
    L 790 92 L 790 62 L 830 62 L 830 74 L 870 74 L 870 62 L 900 62 L 900 92
    L 930 92
    Q 980 40 1030 64 Q 1080 40 1130 64
    L 1150 64 L 1150 92
    L 1170 92 Q 1185 85 1200 88
    L 1200 120 Z
  `,
  nyc: `
    M 0 120 L 0 90
    L 30 90 L 30 72 L 60 72 L 60 90
    L 80 90 L 80 50 L 100 50 L 100 40 L 120 40 L 120 50 L 140 50 L 140 90
    L 160 90 L 160 60 L 200 60 L 200 68 L 240 68 L 240 54 L 280 54 L 280 90
    L 300 90 L 300 38 L 320 38 L 320 22 L 330 22 L 330 10 L 335 10 L 335 22 L 345 22 L 345 38 L 365 38 L 365 90
    L 400 90 L 400 46 L 440 46 L 440 90
    L 470 90 L 470 30 L 490 30 L 490 18 L 510 18 L 510 30 L 530 30 L 530 90
    L 570 90 L 570 55 L 620 55 L 620 65 L 670 65 L 670 42 L 700 42 L 700 90
    L 730 90 L 730 36 L 750 36 L 750 24 L 770 24 L 770 36 L 790 36 L 790 90
    L 820 90 L 820 50 L 870 50 L 870 90
    L 900 90 L 900 20 L 920 20 L 920 8 L 930 8 L 930 2 L 935 2 L 935 20 L 955 20 L 955 90
    L 990 90 L 990 45 L 1030 45 L 1030 55 L 1070 55 L 1070 68 L 1110 68 L 1110 78 L 1150 78 L 1150 88 L 1200 88
    L 1200 120 Z
  `,
  philly: `
    M 0 120 L 0 88 L 20 88
    Q 70 24 140 78
    L 180 78
    Q 220 24 280 78
    L 300 88
    L 340 88 L 340 68 L 380 68 L 380 78 L 410 78 L 410 88
    L 450 88 L 450 44 L 470 44 L 470 32 L 490 32 L 490 44 L 510 44 L 510 88
    L 550 88 L 550 60 L 600 60 L 600 88
    L 620 88 L 620 32 L 640 32 L 640 18 L 660 18 L 660 32 L 680 32 L 680 88
    L 700 88 L 700 40 L 720 40 L 720 28 L 740 28 L 740 40 L 760 40 L 760 88
    L 790 88 L 790 66 L 820 66 L 820 50 L 860 50 L 860 88
    L 890 88 L 890 58 L 930 58 L 930 70 L 970 70 L 970 58 L 1010 58 L 1010 88
    L 1050 88 L 1050 72 L 1100 72 L 1100 82 L 1150 82 L 1150 88 L 1200 88
    L 1200 120 Z
  `,
  chattanooga: `
    M 0 120 L 0 90
    L 80 50 L 140 70 L 200 40 L 260 62 L 310 82
    L 340 82
    Q 390 40 440 82
    L 490 82
    Q 540 40 590 82
    L 620 82
    L 620 62 L 650 62 L 650 44 L 680 44 L 680 62 L 720 62 L 720 82
    L 750 82 L 750 70 L 790 70 L 790 58 L 820 58 L 820 82
    L 850 82 L 850 66 L 870 54 L 890 66 L 890 82
    L 920 82 L 920 74 L 960 74 L 960 66 L 990 66 L 990 82
    L 1020 82
    L 1080 60 L 1140 72 L 1200 58
    L 1200 120 Z
  `,
};

interface Props {
  city: PulseCity;
  variant: "hero" | "card";
  /** Override the accent color. Defaults to the inherited --accent-rgb. */
  accentRgbVar?: string;
  className?: string;
}

export function CitySkylineSvg({
  city,
  variant,
  accentRgbVar = "var(--accent-rgb)",
  className,
}: Props) {
  const path = SKYLINE_PATHS[city.slug];
  if (!path) return null;

  const isHero = variant === "hero";
  const fillOpacity = isHero ? 0.55 : 0.75;
  // A unique filter ID per instance prevents collisions when multiple
  // cards render simultaneously.
  const filterId = `skyline-glow-${city.slug}-${variant}`;

  return (
    <svg
      className={className}
      viewBox="0 0 1200 120"
      preserveAspectRatio="none"
      width="100%"
      height="100%"
      aria-hidden="true"
      style={{
        display: "block",
        color: `rgb(${accentRgbVar})`,
      }}
    >
      <defs>
        <filter id={filterId} x="-10%" y="-30%" width="120%" height="160%">
          <feGaussianBlur stdDeviation={isHero ? 6 : 2} result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.6 0"
          />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path
        d={path}
        fill={`rgba(${accentRgbVar}, ${fillOpacity})`}
        filter={`url(#${filterId})`}
      />
      {/* Thin lit edge along the rooftops for extra definition. */}
      <path
        d={path}
        fill="none"
        stroke={`rgba(${accentRgbVar}, ${isHero ? 0.8 : 0.9})`}
        strokeWidth={isHero ? 1 : 0.75}
        strokeLinejoin="round"
      />
    </svg>
  );
}
