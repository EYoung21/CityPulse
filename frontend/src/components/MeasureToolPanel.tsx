"use client";

import { Ruler, X, Undo2 } from "lucide-react";

interface Props {
  active: boolean;
  points: [number, number][];
  /** Toggle between "measuring" and "off". When turning off, the host
   *  should also clear the points array. */
  onToggle: () => void;
  /** Pop the last point. */
  onUndo: () => void;
  /** Clear all points but stay in measuring mode. */
  onClear: () => void;
}

const R_KM = 6371;

function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return R_KM * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Initial bearing (great-circle) from `a` to `b`, in compass degrees. */
function bearingDeg(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(a[0]);
  const φ2 = toRad(b[0]);
  const Δλ = toRad(b[1] - a[1]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}

function compass(deg: number): string {
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(((deg % 360) / 360) * 8) % 8;
  return labels[idx];
}

function fmtKm(km: number, useImperial: boolean): string {
  if (useImperial) {
    const mi = km * 0.621371;
    if (mi < 0.1) {
      const ft = km * 3280.84;
      return `${Math.round(ft)} ft`;
    }
    return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  }
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

/** Floating measurement readout. Mounted in the bottom-right control
 *  column when measure mode is on; hosts the toggle, undo, clear, and
 *  the running totals (cumulative distance + bearing of the last leg).
 *  When measure mode is off, this component renders nothing — the host
 *  is responsible for surfacing the activate button (e.g. in the
 *  layers menu). */
export default function MeasureToolPanel({
  active,
  points,
  onToggle,
  onUndo,
  onClear,
}: Props) {
  if (!active) return null;

  const useImperial = (() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("pp:units") === "imperial"; }
    catch { return false; }
  })();

  let totalKm = 0;
  for (let i = 1; i < points.length; i++) {
    totalKm += haversineKm(points[i - 1], points[i]);
  }

  const lastLegKm =
    points.length >= 2
      ? haversineKm(points[points.length - 2], points[points.length - 1])
      : 0;
  const lastBearing =
    points.length >= 2
      ? bearingDeg(points[points.length - 2], points[points.length - 1])
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto rounded-2xl backdrop-blur-xl shadow-2xl px-3 py-2 max-w-[calc(100vw-2rem)]"
      style={{
        background: "var(--panel-bg)",
        border: "1px solid rgba(245,158,11,0.40)",
        color: "var(--panel-text)",
      }}
    >
      <div className="flex items-center gap-3">
        <div
          className="shrink-0 w-8 h-8 rounded-xl inline-flex items-center justify-center"
          style={{ background: "rgba(245,158,11,0.18)", color: "#f59e0b" }}
        >
          <Ruler className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          {points.length === 0 ? (
            <p className="text-xs leading-snug" style={{ color: "var(--panel-text-secondary)" }}>
              Tap the map to start measuring.
            </p>
          ) : (
            <>
              <p className="text-sm font-semibold tabular-nums">
                {fmtKm(totalKm, useImperial)}
                <span
                  className="ml-1.5 text-[10px] font-normal"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  · {points.length} pt{points.length !== 1 ? "s" : ""}
                </span>
              </p>
              {points.length >= 2 && lastBearing != null && (
                <p
                  className="text-[10px] tabular-nums"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  Last leg {fmtKm(lastLegKm, useImperial)} · {compass(lastBearing)}{" "}
                  {Math.round(lastBearing)}°
                </p>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onUndo}
            disabled={points.length === 0}
            className="w-7 h-7 rounded-md inline-flex items-center justify-center disabled:opacity-40"
            style={{
              background: "var(--panel-input-bg)",
              color: "var(--panel-text-secondary)",
              border: "1px solid var(--panel-border)",
            }}
            aria-label="Undo last measurement point"
            title="Undo last point"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={points.length === 0}
            className="text-[10px] font-semibold uppercase tracking-wider px-1.5 h-7 rounded-md disabled:opacity-40"
            style={{
              background: "var(--panel-input-bg)",
              color: "var(--panel-text-secondary)",
              border: "1px solid var(--panel-border)",
            }}
            aria-label="Clear all measurement points"
            title="Clear all points"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onToggle}
            className="w-7 h-7 rounded-md inline-flex items-center justify-center"
            style={{
              background: "rgba(245,158,11,0.18)",
              color: "#f59e0b",
              border: "1px solid rgba(245,158,11,0.30)",
            }}
            aria-label="Exit measurement mode"
            title="Exit measure mode"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
