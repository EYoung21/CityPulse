"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, X, Footprints, Bike, Car, Accessibility, ShieldCheck, AlertTriangle, Clock, MapPin, Star } from "lucide-react";
import { preferredSpeedUnit } from "@/hooks/useGpsSpeed";
import { updateTrip } from "@/lib/trip-history";

const MODE_ICON: Record<string, typeof Footprints> = {
  "foot-walking":   Footprints,
  "cycling-regular": Bike,
  "driving-car":    Car,
  "wheelchair":     Accessibility,
};

const MODE_LABEL: Record<string, string> = {
  "foot-walking":   "Walked",
  "cycling-regular": "Cycled",
  "driving-car":    "Drove",
  "wheelchair":     "Rolled",
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
  /** Optional trip-history entry id this recap was persisted under.
   *  When provided, rating/notes edits on the recap card are mirrored
   *  back to history via updateTrip() so they show up in the sidebar. */
  historyId?: string | null;
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
export default function TripRecapCard({ recap, onClose, historyId }: Props) {
  const [visible, setVisible] = useState(true);
  const [rating, setRating] = useState(0);
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const Icon = MODE_ICON[recap.mode] || CheckCircle2;
  const verb = MODE_LABEL[recap.mode] || "Trip";
  const elapsed = recap.endedAt - recap.startedAt;
  const unit = preferredSpeedUnit();
  const dist = fmtDistance(recap.traveledKm, unit);

  // Cancel the auto-dismiss timer once the user starts interacting with
  // the rating / notes controls — otherwise the card vanishes mid-edit.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userInteractedRef = useRef(false);

  useEffect(() => {
    dismissTimerRef.current = setTimeout(() => {
      if (userInteractedRef.current) return;
      setVisible(false);
      setTimeout(onClose, 250);
    }, 12_000);
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [onClose]);

  const cancelAutoDismiss = () => {
    userInteractedRef.current = true;
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  };

  const handleRate = (n: number) => {
    cancelAutoDismiss();
    const next = rating === n ? 0 : n;
    setRating(next);
    if (historyId) updateTrip(historyId, { rating: next });
  };

  // Debounce notes saves so we don't write to localStorage on every
  // keystroke. 600ms feels snappy enough for a "saved" indicator.
  useEffect(() => {
    if (!historyId || !notesOpen) return;
    const t = setTimeout(() => updateTrip(historyId, { notes: notes.trim() }), 600);
    return () => clearTimeout(t);
  }, [notes, notesOpen, historyId]);

  return (
    <div
      className="pp-below-app-topnav fixed inset-x-0 z-[2100] flex justify-center px-3 pointer-events-none"
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

        {historyId && (
          <div
            className="px-4 pb-3 pt-1 flex flex-col gap-2"
            style={{ borderTop: "1px solid var(--panel-border)" }}
          >
            <div className="flex items-center justify-between mt-2">
              <p
                className="text-[10px] uppercase tracking-wider font-semibold"
                style={{ color: "var(--panel-text-muted)" }}
              >
                Rate this trip
              </p>
              <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Rate this trip">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => handleRate(n)}
                    className="p-1 transition-transform hover:scale-110"
                    aria-label={`${n} star${n === 1 ? "" : "s"}`}
                    role="radio"
                    aria-checked={rating === n}
                  >
                    <Star
                      className="w-4 h-4"
                      style={{
                        color: rating >= n ? "#f59e0b" : "var(--panel-text-muted)",
                        fill: rating >= n ? "#f59e0b" : "transparent",
                      }}
                    />
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => { cancelAutoDismiss(); setNotesOpen((v) => !v); }}
              className="self-start text-[11px] hover:underline"
              style={{ color: "var(--panel-text-muted)" }}
            >
              {notesOpen ? "Hide notes" : "Add a note"}
            </button>
            {notesOpen && (
              <textarea
                value={notes}
                aria-label="Trip notes"
                onChange={(e) => { cancelAutoDismiss(); setNotes(e.target.value); }}
                placeholder="What stood out? (saved automatically)"
                rows={2}
                maxLength={280}
                className="w-full resize-none text-xs rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-blue-500/40"
                style={{
                  background: "var(--panel-input-bg)",
                  color: "var(--panel-text)",
                  border: "1px solid var(--panel-border)",
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
