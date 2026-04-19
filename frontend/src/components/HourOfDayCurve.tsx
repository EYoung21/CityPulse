"use client";

/** Compact 24-bar SVG sparkline showing relative incident counts by
 *  hour-of-day. The current hour is highlighted in the same risk
 *  colour the parent SafetyScoreCard uses, so the curve reads as
 *  "how does *now* compare to other times of day at this spot?" at
 *  a glance.
 *
 *  Renders nothing when the underlying profile has too few incidents
 *  to be meaningful (`enoughData === false`). */

import { useMemo } from "react";
import {
  buildTimeOfDayProfile,
  formatHourLabel,
  summarizeProfile,
} from "@/lib/time-of-day-risk";
import type { Incident } from "@/lib/api";

interface Props {
  lat: number;
  lng: number;
  incidents: Incident[];
  /** Risk-color from the parent card (used to tint the "now" bar so
   *  the visual matches the headline score). */
  accentColor: string;
  /** Match the SafetyScoreCard's own radius for consistency. */
  radiusKm?: number;
}

const BAR_W = 6;
const BAR_GAP = 2;
const ROW_W = 24 * BAR_W + 23 * BAR_GAP; // 168
const ROW_H = 32;

export default function HourOfDayCurve({
  lat,
  lng,
  incidents,
  accentColor,
  radiusKm = 0.8,
}: Props) {
  const profile = useMemo(
    () => buildTimeOfDayProfile({ lat, lng }, incidents, radiusKm),
    [lat, lng, incidents, radiusKm]
  );

  if (!profile.enoughData) return null;

  const max = Math.max(1, ...profile.buckets);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <p
          className="text-[10px] font-mono uppercase tracking-wider"
          style={{ color: "var(--panel-text-muted)" }}
        >
          24-hour Pattern
        </p>
        <p
          className="text-[10px] font-mono"
          style={{ color: "var(--panel-text-muted)" }}
        >
          {profile.total} incident{profile.total === 1 ? "" : "s"} · 800m radius
        </p>
      </div>

      <svg
        viewBox={`0 0 ${ROW_W} ${ROW_H + 12}`}
        width="100%"
        height="44"
        role="img"
        aria-label={`24-hour incident pattern. Peak hour ${formatHourLabel(profile.peakHour)}.`}
        style={{ overflow: "visible" }}
      >
        {profile.buckets.map((v, h) => {
          const norm = v / max;
          const barH = Math.max(2, norm * ROW_H);
          const x = h * (BAR_W + BAR_GAP);
          const y = ROW_H - barH;
          const isNow = h === profile.currentHour;
          const isPeak = h === profile.peakHour && !isNow;
          // Bars that fall in the same diurnal block as the user
          // ("morning rush", "late night") share a subtle background
          // tint so the eye can see "we're in the busy block" without
          // having to count bars.
          const fill = isNow
            ? accentColor
            : isPeak
              ? "rgba(239,68,68,0.55)"
              : "rgba(148,163,184,0.55)";
          return (
            <g key={h}>
              <rect x={x} y={y} width={BAR_W} height={barH} rx={1.5} fill={fill} />
              {isNow && (
                <rect
                  x={x - 1}
                  y={ROW_H + 1}
                  width={BAR_W + 2}
                  height={2}
                  rx={1}
                  fill={accentColor}
                />
              )}
            </g>
          );
        })}

        {/* Hour ticks: 12 AM, 6 AM, noon, 6 PM. Light, monospace,
            spaced to align with the matching bars. */}
        {[0, 6, 12, 18].map((h) => {
          const x = h * (BAR_W + BAR_GAP) + BAR_W / 2;
          return (
            <text
              key={h}
              x={x}
              y={ROW_H + 11}
              fontSize="7"
              textAnchor="middle"
              fontFamily="ui-monospace, Menlo, monospace"
              fill="var(--panel-text-muted)"
            >
              {h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`}
            </text>
          );
        })}
      </svg>

      <p className="text-[11px] leading-snug" style={{ color: "var(--panel-text-secondary)" }}>
        {summarizeProfile(profile)}
      </p>
    </div>
  );
}
