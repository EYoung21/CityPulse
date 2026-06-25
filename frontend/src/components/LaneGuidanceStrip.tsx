"use client";

import {
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CornerUpLeft,
  CornerUpRight,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import type { LaneGuidance } from "@/lib/routing";

interface Props {
  lanes?: LaneGuidance[];
  compact?: boolean;
  variant?: "nav" | "panel";
}

function iconForDirection(direction: string): LucideIcon {
  const d = direction.toLowerCase().replace(/[_-]+/g, " ");
  if (d.includes("u turn") || d.includes("uturn")) return RotateCcw;
  if (d.includes("sharp") && d.includes("left")) return CornerUpLeft;
  if (d.includes("sharp") && d.includes("right")) return CornerUpRight;
  if (d.includes("left")) return ArrowUpLeft;
  if (d.includes("right")) return ArrowUpRight;
  return ArrowUp;
}

export default function LaneGuidanceStrip({ lanes, compact = false, variant = "nav" }: Props) {
  if (!lanes || lanes.length === 0) return null;
  return (
    <div className={`mt-2 flex items-center gap-1 ${compact ? "max-w-full" : ""}`} aria-label="Lane guidance">
      {lanes.map((lane, idx) => {
        const first = lane.directions[0] ?? "straight";
        const Icon = iconForDirection(first);
        return (
          <span
            key={`${first}-${idx}`}
            title={lane.directions.join(", ")}
            className={`inline-flex shrink-0 items-center justify-center rounded-md ${
              compact ? "h-6 w-6" : "h-8 w-8"
            }`}
            style={{
              background: lane.recommended
                ? variant === "panel" ? "rgba(34,197,94,0.14)" : "rgba(34,197,94,0.24)"
                : variant === "panel" ? "var(--panel-input-bg)" : "rgba(255,255,255,0.12)",
              border: lane.recommended
                ? "1px solid rgba(34,197,94,0.65)"
                : variant === "panel" ? "1px solid var(--panel-border)" : "1px solid rgba(255,255,255,0.18)",
              color: lane.recommended
                ? variant === "panel" ? "#16a34a" : "#bbf7d0"
                : variant === "panel" ? "var(--panel-text-secondary)" : "rgba(255,255,255,0.76)",
            }}
          >
            <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden />
          </span>
        );
      })}
    </div>
  );
}
