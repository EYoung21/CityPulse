"use client";

import { useEffect, useState } from "react";
import { Car, Footprints, MapPin, Pencil, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  clearParkedPin,
  distanceToParkedM,
  getParkedPin,
  setParkedPin,
  subscribeParkedPin,
  updateParkedNote,
  type ParkedPin,
} from "@/lib/parked-pin";
import { requestUndoableAction } from "@/lib/undo-toast";

interface Props {
  /** Current device location, used to surface a live "X away" hint
   *  and to wire the Walk-back button to the routing pipeline. */
  userLocation: { lat: number; lng: number } | null;
  /** Fly to the parked-pin coordinates (no other side effects). */
  onLocate: (lat: number, lng: number) => void;
}

function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m / 5) * 5} m away`;
  return `${(m / 1000).toFixed(m < 5000 ? 1 : 0)} km away`;
}

function fmtAge(ts: number): string {
  const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${hr}h ago` : `${hr}h ${rem}m ago`;
}

/** Bottom-anchored pill that surfaces an active parked-pin and offers
 *  a one-tap "Walk back" route. Subscribed to the parked-pin store so
 *  it appears the moment the user drops a pin and disappears when
 *  they clear it (or when the 24h TTL kicks in on next mount).
 *
 *  Intentionally separate from the dropped-pin sticky card — that one
 *  is for *exploring* a tapped location, this one is a *commitment*
 *  about where the car is parked, with persistence semantics to match. */
export default function ParkedPinPill({ userLocation, onLocate }: Props) {
  const [pin, setPin] = useState<ParkedPin | null>(() => getParkedPin());
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");

  useEffect(() => {
    setPin(getParkedPin());
    return subscribeParkedPin(setPin);
  }, []);

  if (!pin) return null;

  const distM = userLocation ? distanceToParkedM(userLocation, pin) : null;

  const handleWalkBack = () => {
    if (!pin) return;
    // Reuse the existing plan-route event so the directions panel
    // hydrates the destination and (if a user location exists) the
    // origin chip. We pin the mode to "foot-walking" since the parked
    // pin is car-context — driving back to your own car is silly.
    window.dispatchEvent(
      new CustomEvent("pp:plan-route", {
        detail: {
          mode: "to",
          lat: pin.lat,
          lng: pin.lng,
          label: pin.label || "Parked here",
          // The DirectionsPanel doesn't currently honor a `transport`
          // hint via this event, but we forward it for forward-compat
          // with a future enhancement.
          transport: "foot-walking",
        },
      })
    );
  };

  const handleNoteSubmit = () => {
    const next = noteDraft.trim().slice(0, 120);
    updateParkedNote(next);
    setEditingNote(false);
  };

  return (
    <AnimatePresence>
      <motion.div
        key="parked-pin-pill"
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 24, opacity: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
        className="fixed inset-x-0 z-[1090] flex justify-center px-3 pointer-events-none"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 6.5rem)" }}
        role="status"
        aria-label="Parked car location"
      >
        <div
          className="pointer-events-auto w-full max-w-md rounded-2xl shadow-2xl backdrop-blur-xl overflow-hidden"
          style={{
            background: "var(--panel-bg)",
            border: "1px solid var(--panel-border)",
          }}
        >
          <div className="px-3 py-2.5 flex items-start gap-3">
            <div
              className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center mt-0.5"
              style={{
                background: "rgba(168, 85, 247, 0.2)",
                color: "#a855f7",
              }}
            >
              <Car className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p
                className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--panel-text-muted)" }}
              >
                Parked · {fmtAge(pin.ts)}
              </p>
              <p
                className="text-sm font-semibold truncate mt-0.5"
                style={{ color: "var(--panel-text)" }}
                title={pin.label || "Parked here"}
              >
                {pin.label || "Parked here"}
              </p>
              <p className="text-[11px]" style={{ color: "var(--panel-text-muted)" }}>
                {distM != null ? fmtDist(distM) : `${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`}
              </p>
              {editingNote ? (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleNoteSubmit();
                      if (e.key === "Escape") { setEditingNote(false); setNoteDraft(pin.note || ""); }
                    }}
                    onBlur={handleNoteSubmit}
                    placeholder="e.g. 4th floor, B level"
                    maxLength={120}
                    className="flex-1 text-[11px] px-2 py-1 rounded-md outline-none focus:ring-1 focus:ring-purple-500/40"
                    style={{
                      background: "var(--panel-input-bg)",
                      color: "var(--panel-text)",
                      border: "1px solid var(--panel-border)",
                    }}
                  />
                </div>
              ) : pin.note ? (
                <button
                  type="button"
                  onClick={() => { setEditingNote(true); setNoteDraft(pin.note || ""); }}
                  className="mt-1 flex items-start gap-1 text-[11px] italic text-left hover:underline"
                  style={{ color: "var(--panel-text-secondary)" }}
                  title="Tap to edit"
                >
                  <Pencil className="w-2.5 h-2.5 shrink-0 mt-0.5 opacity-60" />
                  <span className="line-clamp-2">{pin.note}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setEditingNote(true); setNoteDraft(""); }}
                  className="mt-1 flex items-center gap-1 text-[11px] hover:underline"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  <Pencil className="w-2.5 h-2.5 opacity-60" />
                  Add note
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                // Snapshot the current pin so the undo path can restore
                // the *exact* value (note + label included), not just
                // a re-derived approximation. We clear immediately so
                // the UI feels responsive; the snapshot lives in the
                // closure for the toast's lifetime.
                const snap = pin;
                clearParkedPin();
                requestUndoableAction({
                  label: "Parked pin cleared",
                  detail: snap.label || `${snap.lat.toFixed(4)}, ${snap.lng.toFixed(4)}`,
                  onConfirm: () => { /* nothing — already cleared */ },
                  onUndo: () => {
                    setParkedPin({ lat: snap.lat, lng: snap.lng, label: snap.label, note: snap.note });
                  },
                });
              }}
              className="shrink-0 p-1.5 rounded-md transition-colors"
              style={{ color: "var(--panel-text-muted)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              aria-label="Clear parked pin"
              title="Clear parked location"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div
            className="flex gap-1 px-2 pb-2"
            style={{ borderTop: "1px solid var(--panel-border)" }}
          >
            <button
              type="button"
              onClick={() => onLocate(pin.lat, pin.lng)}
              className="flex-1 mt-2 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{
                background: "var(--panel-input-bg)",
                color: "var(--panel-text-secondary)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "var(--panel-input-bg)")}
            >
              <MapPin className="w-3.5 h-3.5" />
              Show on map
            </button>
            <button
              type="button"
              onClick={handleWalkBack}
              disabled={!userLocation}
              className="flex-1 mt-2 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: userLocation ? "linear-gradient(90deg, #a855f7, #8b5cf6)" : "var(--panel-input-bg)",
                color: userLocation ? "#fff" : "var(--panel-text-muted)",
              }}
              title={userLocation ? "Walk back to your car" : "Enable location to walk back"}
            >
              <Footprints className="w-3.5 h-3.5" />
              Walk back
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
