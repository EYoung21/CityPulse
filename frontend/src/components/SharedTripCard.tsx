"use client";

import { useEffect, useState } from "react";
import { Navigation, X, Footprints, Bike, Car, Clock, MapPin, Accessibility, TrainFront, TramFront } from "lucide-react";
import type { DecodedTripToken } from "@/lib/share-trip";
import type { TransportMode } from "@/lib/routing";

interface Props {
  trip: DecodedTripToken;
  onClose: () => void;
}

const MODE_ICON: Record<TransportMode, typeof Footprints> = {
  "foot-walking":   Footprints,
  "cycling-regular": Bike,
  "driving-car":    Car,
  "wheelchair":     Accessibility,
  "transit-train":  TrainFront,
  "transit-subway": TramFront,
};

function fmtRemaining(ms: number): string {
  if (ms <= 0) return "Arriving now";
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Read-only "live ETA" tracker shown to a recipient who opened a
 *  /?trip=<token> link. The route polyline itself is rendered on the map
 *  by `IncidentMap` (via the `previewWaypoints` channel); this component
 *  is the tracking pill / detail card sitting above it. */
export default function SharedTripCard({ trip, onClose }: Props) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const remainingMs = trip.etaEpochMs - now;
  const totalMs = Math.max(1, trip.etaEpochMs - trip.sentAtEpochMs);
  const elapsed = Math.max(0, Math.min(1, (now - trip.sentAtEpochMs) / totalMs));
  const arrived = remainingMs <= 0;
  const stale = now > trip.etaEpochMs + 10 * 60_000;

  const Icon = MODE_ICON[trip.mode] || Navigation;
  const senderLabel = trip.name?.trim() || "Someone";
  const verb = trip.mode === "foot-walking" ? "walking" : trip.mode === "cycling-regular" ? "biking" : "driving";

  return (
    <div
      className="pp-below-app-topnav fixed left-1/2 -translate-x-1/2 z-[2100] w-[min(420px,calc(100vw-1.5rem))] rounded-2xl shadow-2xl backdrop-blur-xl overflow-hidden"
      style={{
        background: "var(--panel-bg)",
        border: "1px solid var(--panel-border)",
      }}
      role="status"
      aria-live="polite"
    >
      <div
        className="px-4 py-3 flex items-center gap-3"
        style={{
          background: arrived
            ? "linear-gradient(90deg, rgba(34,197,94,0.18), rgba(34,197,94,0.02))"
            : stale
              ? "linear-gradient(90deg, rgba(245,158,11,0.18), rgba(245,158,11,0.02))"
              : "linear-gradient(90deg, rgba(59,130,246,0.18), rgba(59,130,246,0.02))",
        }}
      >
        <div
          className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center"
          style={{
            background: arrived ? "rgba(34,197,94,0.22)" : "rgba(59,130,246,0.22)",
            color: arrived ? "#22c55e" : "#3b82f6",
          }}
        >
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wider font-semibold" style={{ color: "var(--panel-text-muted)" }}>
            Live ETA
          </p>
          <p className="text-sm font-semibold truncate" style={{ color: "var(--panel-text)" }}>
            {senderLabel} is {verb}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss live ETA"
          className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors"
          style={{ color: "var(--panel-text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-3 space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-3xl font-bold leading-none" style={{ color: "var(--panel-text)" }}>
              {fmtRemaining(remainingMs)}
            </p>
            <p className="text-xs mt-1 flex items-center gap-1" style={{ color: "var(--panel-text-secondary)" }}>
              <Clock className="w-3 h-3" />
              ETA {fmtClock(trip.etaEpochMs)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--panel-text-muted)" }}>
              Sent
            </p>
            <p className="text-xs" style={{ color: "var(--panel-text-secondary)" }}>
              {fmtClock(trip.sentAtEpochMs)}
            </p>
          </div>
        </div>

        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "var(--panel-input-bg)" }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${elapsed * 100}%`,
              background: arrived
                ? "linear-gradient(90deg,#22c55e,#4ade80)"
                : "linear-gradient(90deg,#3b82f6,#60a5fa)",
            }}
          />
        </div>

        <div
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
          style={{ background: "var(--panel-input-bg)", color: "var(--panel-text-secondary)" }}
        >
          <MapPin className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">
            Heading to {trip.destination[0].toFixed(4)}, {trip.destination[1].toFixed(4)}
          </span>
        </div>

        {stale && !arrived && (
          <p className="text-[11px] text-amber-500/90">
            This ETA was sent {Math.round((now - trip.sentAtEpochMs) / 60000)} min ago and may be out of date.
          </p>
        )}
      </div>
    </div>
  );
}
