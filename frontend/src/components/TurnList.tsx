"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  ArrowUpLeft,
  CornerUpRight,
  CornerUpLeft,
  RotateCcw,
  Flag,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ManeuverStep } from "@/lib/routing";
import LaneGuidanceStrip from "@/components/LaneGuidanceStrip";

interface Props {
  steps: ManeuverStep[];
  geometry: [number, number][];
  /** 0..1 progress along the geometry — used to dim already-completed
   *  steps and highlight the active one. */
  tripProgress: number;
  onClose: () => void;
}

const MANEUVER_ICON: Record<number, LucideIcon> = {
  0: CornerUpLeft,
  1: CornerUpRight,
  2: CornerUpLeft,
  3: CornerUpRight,
  4: ArrowUpLeft,
  5: ArrowUpRight,
  6: ArrowUp,
  7: RotateCcw,
  8: RotateCcw,
  9: RotateCcw,
  10: Flag,
  11: ArrowUp,
  12: ArrowUpLeft,
  13: ArrowUpRight,
};

function fmtMeters(m: number): string {
  if (m < 50) return `${Math.round(m / 5) * 5} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function stepSupplement(step: ManeuverStep): string {
  return [
    step.exitNumber ? `Exit ${step.exitNumber}` : "",
    step.signpostText,
    step.roadNumbers?.join(", "),
  ].filter(Boolean).join(" · ");
}

/** Full scrollable list of upcoming maneuvers. Dropped over the trip
 *  HUD on tap of the "Steps" button on ManeuverChip. Already-passed
 *  steps fade out so the list stays focused on what's left ahead. */
export default function TurnList({ steps, geometry, tripProgress, onClose }: Props) {
  const [enter, setEnter] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setEnter(true));
    return () => cancelAnimationFrame(t);
  }, []);

  const currentIdx = Math.min(
    geometry.length - 1,
    Math.max(0, Math.floor(tripProgress * (geometry.length - 1)))
  );

  const activeStepIdx = useMemo(() => {
    if (steps.length === 0) return -1;
    let i = steps.findIndex(
      (s) => currentIdx >= s.way_points[0] && currentIdx <= s.way_points[1]
    );
    if (i === -1) i = steps.findIndex((s) => s.way_points[1] >= currentIdx);
    if (i === -1) i = steps.length - 1;
    return i;
  }, [steps, currentIdx]);

  return (
    <div
      className="fixed inset-x-0 z-[1080] flex justify-center px-3"
      style={{
        // Sit above the TripHUD's bottom safe area, with room for the
        // ManeuverChip itself which lives above this list.
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 11rem)",
        top: "calc(env(safe-area-inset-top, 0px) + 4rem)",
        opacity: enter ? 1 : 0,
        transition: "opacity 0.2s ease",
      }}
      role="dialog"
      aria-label="Turn-by-turn directions"
    >
      <div
        className="w-full max-w-md flex flex-col rounded-2xl backdrop-blur-xl shadow-2xl overflow-hidden"
        style={{
          background: "var(--panel-bg)",
          border: "1px solid var(--panel-border)",
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--panel-border)" }}
        >
          <h2 className="text-sm font-semibold" style={{ color: "var(--panel-text)" }}>
            All steps ({steps.length})
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close steps list"
            className="p-1.5 rounded-full transition-colors"
            style={{ color: "var(--panel-text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div
          className="flex-1 overflow-y-auto"
          style={{ background: "var(--panel-bg)" }}
        >
          {steps.length === 0 ? (
            <div
              className="px-4 py-8 text-center text-sm"
              style={{ color: "var(--panel-text-muted)" }}
            >
              No turn-by-turn data for this route.
            </div>
          ) : (
            <ol className="flex flex-col">
              {steps.map((s, i) => {
                const Icon = MANEUVER_ICON[s.type] ?? ArrowUp;
                const isActive = i === activeStepIdx;
                const isPast = i < activeStepIdx;
                const supplement = stepSupplement(s);
                return (
                  <li
                    key={i}
                    className="flex items-start gap-3 px-4 py-3 transition-colors"
                    style={{
                      background: isActive ? "rgba(59,130,246,0.08)" : "transparent",
                      borderTop: i === 0 ? "none" : "1px solid var(--panel-border)",
                      opacity: isPast ? 0.45 : 1,
                    }}
                    aria-current={isActive ? "step" : undefined}
                  >
                    <div
                      className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center mt-0.5"
                      style={{
                        background: isActive
                          ? "rgba(59,130,246,0.18)"
                          : "var(--panel-input-bg)",
                        color: isActive ? "#3b82f6" : "var(--panel-text-secondary)",
                      }}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p
                        className="text-sm font-medium leading-snug"
                        style={{ color: "var(--panel-text)" }}
                      >
                        {s.instruction}
                      </p>
                      <p
                        className="text-xs mt-0.5"
                        style={{ color: "var(--panel-text-muted)" }}
                      >
                        {fmtMeters(s.distance)}
                        {s.name ? ` · ${s.name}` : ""}
                      </p>
                      {supplement && (
                        <p
                          className="text-[11px] mt-0.5 truncate"
                          style={{ color: "var(--panel-text-muted)" }}
                        >
                          {supplement}
                        </p>
                      )}
                      <LaneGuidanceStrip lanes={s.lanes} compact variant="panel" />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
