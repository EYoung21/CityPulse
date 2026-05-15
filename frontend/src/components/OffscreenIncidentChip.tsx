"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, X, Navigation } from "lucide-react";
import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";

interface Props {
  incident: Incident;
  /** Compass bearing in degrees (0=N, 90=E) from the current map center
   *  toward the incident. Used to render a directional arrow. */
  bearingDeg: number;
  onTap: () => void;
  onDismiss: () => void;
}

function fmtAge(ts?: string | null): string {
  if (!ts) return "just now";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "just now";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ago`;
}

/** Compass-arrow chip that pops up when a fresh, off-screen incident
 *  warrants the user's attention (high severity within ~3 km of the
 *  current viewport). Tap to fly there and select it; dismiss to mute. */
export default function OffscreenIncidentChip({
  incident,
  bearingDeg,
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
      className="pp-below-app-topnav pointer-events-none fixed inset-x-0 z-[1100] flex justify-center px-3"
      style={{
        opacity: enter ? 1 : 0,
        transform: enter ? "translateY(0)" : "translateY(-8px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
      }}
    >
      <div
        className="pointer-events-auto w-full max-w-md flex items-center gap-3 px-3 py-2.5 rounded-full backdrop-blur-xl shadow-2xl"
        style={{
          background: "var(--panel-bg)",
          border: `1px solid ${sev.color}55`,
          boxShadow: `0 8px 32px ${sev.color}33, 0 2px 8px rgba(0,0,0,0.25)`,
        }}
        role="alert"
        aria-live="polite"
      >
        <button
          type="button"
          onClick={onTap}
          className="flex items-center gap-3 flex-1 min-w-0 text-left active:scale-[0.99] transition-transform"
          aria-label={`Fly to incident: ${incident.severity_category}`}
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
            <p className="text-xs font-bold leading-tight uppercase tracking-wide" style={{ color: sev.color }}>
              New {sev.label} alert
            </p>
            <p className="text-xs leading-tight truncate mt-0.5" style={{ color: "var(--panel-text-secondary)" }}>
              {incident.location_text || sev.label} · {fmtAge(incident.reported_at)}
            </p>
          </div>
          <div
            className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider"
            style={{
              background: "rgba(59,130,246,0.18)",
              color: "#3b82f6",
            }}
          >
            <Navigation
              className="w-3 h-3"
              style={{ transform: `rotate(${bearingDeg - 45}deg)`, transition: "transform 0.3s ease" }}
            />
            View
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
