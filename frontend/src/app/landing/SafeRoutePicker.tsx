"use client";

/**
 * SafeRoutePicker
 *
 * A visual mockup of the real RouteOptionPicker surface. Not interactive
 * and does no data fetching — the landing section drives `selected` state
 * to auto-highlight the "safer" row a beat after the canvas finishes
 * drawing, so the page reads as one continuous demo.
 */

import { Clock, Route as RouteIcon, ShieldCheck, AlertTriangle } from "lucide-react";
import type { RouteDemoPair } from "@/lib/pulse-cities";

type Selected = "fast" | "safer";

interface Props {
  pair: RouteDemoPair;
  selected: Selected;
  /** Accent color in "r, g, b" format; used only for the card frame, not
   *  the row semantic colors (red/green stay universal). */
  accentRgb: string;
}

export function SafeRoutePicker({ pair, selected, accentRgb }: Props) {
  return (
    <div className="lp-route-picker" aria-hidden="true">
      <div className="lp-route-picker-head">
        <span className="lp-route-picker-title">2 routes</span>
        <span className="lp-route-picker-dest">
          {pair.from} → {pair.to}
        </span>
      </div>

      <div className="lp-route-picker-rows">
        {/* Fastest (red) */}
        <div
          className={`lp-route-row ${selected === "fast" ? "selected" : ""}`}
          data-variant="fast"
          style={
            {
              "--accent-rgb": accentRgb,
            } as React.CSSProperties
          }
        >
          <div className="lp-route-row-icon lp-route-row-icon--fast">
            <RouteIcon className="w-4 h-4" />
          </div>
          <div className="lp-route-row-body">
            <div className="lp-route-row-top">
              <span className="lp-route-row-label">Fastest</span>
              <span className="lp-route-row-eta">
                <Clock className="w-3 h-3" />
                {pair.fastestMin} min
              </span>
            </div>
            <div className="lp-route-row-sub">
              <span className="lp-route-badge warn">
                <AlertTriangle className="w-3 h-3" />
                {pair.hotCount} nearby
              </span>
              <span className="lp-route-row-muted">Cuts through hot zone</span>
            </div>
          </div>
        </div>

        {/* Safer (green) */}
        <div
          className={`lp-route-row ${selected === "safer" ? "selected" : ""}`}
          data-variant="safer"
          style={
            {
              "--accent-rgb": accentRgb,
            } as React.CSSProperties
          }
        >
          <div className="lp-route-row-icon lp-route-row-icon--safer">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div className="lp-route-row-body">
            <div className="lp-route-row-top">
              <span className="lp-route-row-label">Safer</span>
              <span className="lp-route-row-eta">
                <Clock className="w-3 h-3" />
                {pair.saferMin} min
                <span className="lp-route-row-delta">
                  +{pair.saferMin - pair.fastestMin}
                </span>
              </span>
            </div>
            <div className="lp-route-row-sub">
              <span className="lp-route-badge safer">
                <ShieldCheck className="w-3 h-3" />0 nearby
              </span>
              <span className="lp-route-row-muted">Routed around</span>
            </div>
          </div>
        </div>
      </div>

      <div className="lp-route-picker-footer">
        <span className="lp-route-picker-cta">Start · Safer</span>
      </div>
    </div>
  );
}
