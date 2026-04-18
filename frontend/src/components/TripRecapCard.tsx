"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, X, Footprints, Bike, Car, ShieldCheck, AlertTriangle, Clock, MapPin } from "lucide-react";
import { preferredSpeedUnit } from "@/hooks/useGpsSpeed";

const MODE_ICON: Record<string, typeof Footprints> = {
  "foot-walking":   Footprints,
  "cycling-regular": Bike,
  "driving-car":    Car,
};

const MODE_LABEL: Record<string, string> = {
  "foot-walking":   "Walked",
  "cycling-regular": "Cycled",
  "driving-car":    "Drove",
};

export interface TripRecap {
  startedAt: number;
  endedAt: number;
  /** Total planned distance in km. */
  totalDistanceKm: number;
  /** Distance traveled (computed from `tripProgress`). */
  traveledKm: number;
  mode: string;
  nearbyIncidents: number;
  wasSafeRoute: boolean;
  /** True if the user reached >= 95% of the route. */
  completed: boolean;
}

interface Props {
  recap: TripRecap;
  onClose: () => void;
}

function fmtElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtDistance(km: number, unit: "mph" | "kmh"): { value: string; label: string } {
  if (unit === "mph") {
    return { value: (km * 0.621371).toFixed(km < 1 ? 2 : 1), label: "mi" };
  }
  return { value: km.toFixed(km < 1 ? 2 : 1), label: "km" };
}

/** Modal-style recap shown when the user ends a trip. Mirrors the
 *  satisfying "you've arrived" summary Maps shows after navigation,
 *  with PhillyPulse-specific details (incidents passed, safe-route
 *  badge). Auto-fades; tap to dismiss. */
export default function TripRecapCard({ recap, onClose }: Props) {
  const [visible, setVisible] = useState(true);
  const Icon = MODE_ICON[recap.mode] || CheckCircle2;
  const verb = MODE_LABEL[recap.mode] || "Trip";
  const elapsed = recap.endedAt - recap.startedAt;
  const unit = preferredSpeedUnit();
  const dist = fmtDistance(recap.traveledKm, unit);

  useEffect(() => {
    // Auto-dismiss after 12 seconds — long enough to read but doesn't
    // linger. The user can also tap the X.
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 250);
    }, 12_000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div
      className="fixed inset-x-0 z-[1100] flex justify-center px-3 pointer-events-none"
      style={{ top: "calc(env(safe-area-inset-top, 0px) + 0.75rem)" }}
    >
      <div
        className="pointer-events-auto w-full max-w-md rounded-2xl shadow-2xl backdrop-blur-xl overflow-hidden transition-all duration-300"
        style={{
          background: "var(--panel-bg)",
          border: "1px solid var(--panel-border)",
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0) scale(1)" : "translateY(-12px) scale(0.97)",
        }}
        role="dialog"
        aria-label="Trip summary"
      >
        <div
          className="px-4 py-3 flex items-center gap-3"
          style={{
            background: recap.completed
              ? "linear-gradient(90deg, rgba(34,197,94,0.18), rgba(34,197,94,0.02))"
              : "linear-gradient(90deg, rgba(59,130,246,0.18), rgba(59,130,246,0.02))",
          }}
        >
          <div
            className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center"
            style={{
              background: recap.completed ? "rgba(34,197,94,0.22)" : "rgba(59,130,246,0.22)",
              color: recap.completed ? "#22c55e" : "#3b82f6",
            }}
          >
            {recap.completed ? <CheckCircle2 className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider font-semibold" style={{ color: "var(--panel-text-muted)" }}>
              {recap.completed ? "Arrived" : "Trip ended"}
            </p>
            <p className="text-sm font-semibold truncate" style={{ color: "var(--panel-text)" }}>
              {verb} {dist.value} {dist.label} in {fmtElapsed(elapsed)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setVisible(false); setTimeout(onClose, 250); }}
            aria-label="Dismiss trip summary"
            className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors"
            style={{ color: "var(--panel-text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-[10px] uppercase tracking-wider flex items-center justify-center gap-1" style={{ color: "var(--panel-text-muted)" }}>
              <MapPin className="w-3 h-3" /> Distance
            </p>
            <p className="text-lg font-bold mt-1" style={{ color: "var(--panel-text)" }}>
              {dist.value}
              <span className="text-xs font-medium ml-0.5" style={{ color: "var(--panel-text-secondary)" }}>{dist.label}</span>
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider flex items-center justify-center gap-1" style={{ color: "var(--panel-text-muted)" }}>
              <Clock className="w-3 h-3" /> Elapsed
            </p>
            <p className="text-lg font-bold mt-1" style={{ color: "var(--panel-text)" }}>
              {fmtElapsed(elapsed)}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider flex items-center justify-center gap-1" style={{ color: "var(--panel-text-muted)" }}>
              <AlertTriangle className="w-3 h-3" /> Nearby
            </p>
            <p className="text-lg font-bold mt-1" style={{ color: recap.nearbyIncidents > 0 ? "#f59e0b" : "var(--panel-text)" }}>
              {recap.nearbyIncidents}
            </p>
          </div>
        </div>

        {recap.wasSafeRoute && (
          <div className="mx-4 mb-3 flex items-center gap-2 text-xs text-green-600 dark:text-green-400/80 bg-green-500/10 rounded-lg px-3 py-2">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            Took the safer route — avoided {recap.nearbyIncidents} reported incident{recap.nearbyIncidents === 1 ? "" : "s"}.
          </div>
        )}
      </div>
    </div>
  );
}
