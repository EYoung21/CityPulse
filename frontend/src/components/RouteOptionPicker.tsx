"use client";

import { Clock, Route as RouteIcon, ShieldCheck, Ban, Loader2, AlertTriangle } from "lucide-react";
import type { RouteOption } from "@/lib/routing";
import type { RouteSafetyScore } from "@/lib/route-safety";

interface Props {
  options: RouteOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
  /** Optional per-route safety scores keyed by RouteOption id. When
   *  provided, each card surfaces a concrete "X nearby" badge and
   *  the option with the lowest weighted exposure earns a "Lowest
   *  exposure" callout — strictly more informative than the binary
   *  `isSafer` flag, which only reflects whether the avoid-polygon
   *  pass returned a result. */
  safetyScores?: Map<string, RouteSafetyScore>;
}

function fmtMin(min: number): string {
  if (min < 1) return "<1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

function iconFor(opt: RouteOption) {
  if (opt.isSafer) return <ShieldCheck className="w-4 h-4" />;
  if (opt.avoidedFeatures.length > 0) return <Ban className="w-4 h-4" />;
  return <RouteIcon className="w-4 h-4" />;
}

/** Maps-style list of route alternatives presented before pressing GO.
 *  Each card shows ETA, distance, and a short qualifier ("Safer",
 *  "No tolls", etc.). Selecting one updates the previewed polyline on
 *  the map and is what gets started when the user finally taps GO. */
export default function RouteOptionPicker({
  options,
  selectedId,
  onSelect,
  loading,
  safetyScores,
}: Props) {
  if (loading && options.length === 0) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-3 rounded-xl text-xs"
        style={{
          background: "var(--panel-secondary-bg)",
          border: "1px solid var(--panel-border)",
          color: "var(--panel-text-secondary)",
        }}
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Finding routes…
      </div>
    );
  }
  if (options.length === 0) return null;

  // Anchor for relative ETA deltas ("+3 min vs fastest").
  const fastestMin = Math.min(...options.map((o) => o.route.durationMin));

  // Find the option with the lowest weighted exposure so we can
  // visually distinguish the "objectively safest" choice. Ties are
  // broken by raw count, then by ETA so the user gets a stable order.
  const lowestExposureId = (() => {
    if (!safetyScores || safetyScores.size === 0) return null;
    let bestId: string | null = null;
    let bestWeighted = Infinity;
    let bestCount = Infinity;
    let bestMin = Infinity;
    for (const opt of options) {
      const s = safetyScores.get(opt.id);
      if (!s) continue;
      if (
        s.weighted < bestWeighted ||
        (s.weighted === bestWeighted && s.count < bestCount) ||
        (s.weighted === bestWeighted && s.count === bestCount && opt.route.durationMin < bestMin)
      ) {
        bestId = opt.id;
        bestWeighted = s.weighted;
        bestCount = s.count;
        bestMin = opt.route.durationMin;
      }
    }
    // Don't crown a winner when every option has the same exposure —
    // that's noise, not a meaningful recommendation.
    const allEqual = options.every((opt) => {
      const s = safetyScores.get(opt.id);
      return s && s.weighted === bestWeighted && s.count === bestCount;
    });
    return allEqual ? null : bestId;
  })();

  return (
    <div className="flex flex-col gap-2">
      <p
        className="text-[10px] uppercase tracking-wider font-semibold px-1"
        style={{ color: "var(--panel-text-muted)" }}
      >
        {options.length === 1 ? "Route" : `${options.length} routes`}
      </p>
      <div className="flex flex-col gap-1.5">
        {options.map((opt) => {
          const isActive = opt.id === selectedId;
          const deltaMin = opt.route.durationMin - fastestMin;
          const deltaLabel =
            deltaMin >= 1
              ? `+${Math.round(deltaMin)} min`
              : null;
          const score = safetyScores?.get(opt.id);
          const isLowestExposure = lowestExposureId !== null && opt.id === lowestExposureId;

          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onSelect(opt.id)}
              className="w-full text-left px-3 py-2.5 rounded-xl transition-all duration-150 active:scale-[0.99] flex items-center gap-3"
              style={{
                background: isActive
                  ? "rgba(34,197,94,0.12)"
                  : "var(--panel-secondary-bg)",
                border: `1px solid ${isActive ? "rgba(34,197,94,0.55)" : "var(--panel-border)"}`,
                boxShadow: isActive
                  ? "0 0 0 3px rgba(34,197,94,0.15)"
                  : "none",
                color: "var(--panel-text)",
              }}
              aria-pressed={isActive}
            >
              <div
                className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center"
                style={{
                  background: opt.isSafer
                    ? "rgba(34,197,94,0.18)"
                    : opt.avoidedFeatures.length > 0
                      ? "rgba(245,158,11,0.18)"
                      : "rgba(59,130,246,0.18)",
                  color: opt.isSafer
                    ? "#22c55e"
                    : opt.avoidedFeatures.length > 0
                      ? "#f59e0b"
                      : "#3b82f6",
                }}
              >
                {iconFor(opt)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold truncate">{opt.label}</p>
                  {deltaLabel && (
                    <span
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                      style={{
                        background: "rgba(148,163,184,0.18)",
                        color: "var(--panel-text-secondary)",
                      }}
                    >
                      {deltaLabel}
                    </span>
                  )}
                </div>
                <p
                  className="text-xs mt-0.5 flex items-center gap-2 flex-wrap"
                  style={{ color: "var(--panel-text-secondary)" }}
                >
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {fmtMin(opt.route.durationMin)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{fmtKm(opt.route.distanceKm)}</span>
                  {opt.subtitle && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{opt.subtitle}</span>
                    </>
                  )}
                  {score && score.count > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span
                        className="inline-flex items-center gap-1"
                        title={`${score.count} recent incident${score.count === 1 ? "" : "s"} within 120 m of this route`}
                        style={{ color: score.weighted >= 3 ? "#f59e0b" : "var(--panel-text-secondary)" }}
                      >
                        <AlertTriangle className="w-3 h-3" />
                        {score.count} nearby
                      </span>
                    </>
                  )}
                </p>
                {isLowestExposure && (
                  <span
                    className="inline-flex items-center gap-1 mt-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                    style={{
                      background: "rgba(34,197,94,0.14)",
                      color: "#22c55e",
                    }}
                    title="Lowest weighted incident exposure of the listed routes"
                  >
                    <ShieldCheck className="w-2.5 h-2.5" />
                    Lowest exposure
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
