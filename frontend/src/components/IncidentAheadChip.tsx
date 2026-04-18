"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";

interface Props {
  incident: Incident;
  /** Distance from the user's current position to the incident along
   *  the route, in meters. Used to format the "in N m / km" copy. */
  distanceM: number;
  onTap: () => void;
  onDismiss: () => void;
}

function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/** Floating chip pinned to the bottom-center of the map during an
 *  active trip when there's a high-severity incident on the route
 *  ahead of the user (within ~1.5 km). Tapping flies the map to the
 *  incident; dismissing mutes it for the rest of this trip. */
export default function IncidentAheadChip({
  incident,
  distanceM,
  onTap,
  onDismiss,
}: Props) {
  const sev = getSeverity(incident.severity_category);
  const [enter, setEnter] = useState(false);

  useEffect(() => {
    const t = requestAnimationFrame(() => setEnter(true));
    return () => cancelAnimationFrame(t);
  }, []);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[1090] flex justify-center px-3"
      style={{
        // Float just above the TripHUD which sits along the bottom safe
        // area. 7rem clears both the HUD and the speed chip.
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 7rem)",
        opacity: enter ? 1 : 0,
        transform: enter ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
      }}
    >
      <div
        className="pointer-events-auto w-full max-w-md flex items-center gap-3 px-3 py-2.5 rounded-full backdrop-blur-xl shadow-2xl"
        style={{
          background: "var(--panel-bg)",
          border: `1px solid ${sev.color}66`,
          boxShadow: `0 8px 32px ${sev.color}33, 0 2px 8px rgba(0,0,0,0.25)`,
        }}
        role="alert"
        aria-live="polite"
      >
        <button
          type="button"
          onClick={onTap}
          className="flex items-center gap-3 flex-1 min-w-0 text-left active:scale-[0.99] transition-transform"
          aria-label={`View incident ahead: ${incident.severity_category}`}
        >
          <div
            className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center relative"
            style={{
              background: `${sev.color}22`,
              color: sev.color,
            }}
          >
            <AlertTriangle className="w-4 h-4" />
            <span
              className="absolute inset-0 rounded-full animate-ping"
              style={{ background: `${sev.color}33`, animationDuration: "1.6s" }}
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0 flex-1">
            <p
              className="text-xs font-bold leading-tight uppercase tracking-wide"
              style={{ color: sev.color }}
            >
              {sev.label} ahead
            </p>
            <p
              className="text-xs leading-tight truncate mt-0.5"
              style={{ color: "var(--panel-text-secondary)" }}
            >
              In {fmtDistance(distanceM)}
              {incident.location_text ? ` · ${incident.location_text}` : ""}
            </p>
          </div>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss alert"
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors"
          style={{ color: "var(--panel-text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
