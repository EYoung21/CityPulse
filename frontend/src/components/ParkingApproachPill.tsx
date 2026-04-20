"use client";

import { useEffect, useState } from "react";
import { ParkingCircle, X } from "lucide-react";

interface Props {
  /** Tap handler — opens AlongRoutePanel pre-selected to "parking". */
  onOpenParking: () => void;
  /** Dismiss handler — also called when the user taps the X. */
  onDismiss: () => void;
}

/** Floating "Need parking?" pill shown when the user is approaching a
 *  driving destination. The host (page.tsx) is responsible for the
 *  trigger conditions (mode, distance, progress) — this component
 *  only owns its own enter/exit animation and the dismiss UX.
 *
 *  Visual is intentionally non-modal: drivers shouldn't have to
 *  acknowledge a popover at the wheel. Tap → opens parking suggestions.
 *  Tap-X → closes for the rest of this trip.
 */
export default function ParkingApproachPill({ onOpenParking, onDismiss }: Props) {
  const [enter, setEnter] = useState(false);

  useEffect(() => {
    // Defer the slide-in so the initial render is the offscreen state
    // and the transition has something to animate from.
    const id = window.setTimeout(() => setEnter(true), 16);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div
      className="pointer-events-none absolute z-[1003] left-1/2 -translate-x-1/2 flex justify-center"
      style={{
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 10rem)",
      }}
      role="status"
      aria-live="polite"
    >
      <div
        className="pointer-events-auto inline-flex items-center gap-2 px-1 py-1 rounded-full shadow-2xl backdrop-blur-xl transition-all duration-300"
        style={{
          background: "var(--panel-bg)",
          border: "1px solid rgba(59,130,246,0.45)",
          color: "var(--panel-text)",
          opacity: enter ? 1 : 0,
          transform: enter ? "translateY(0) scale(1)" : "translateY(8px) scale(0.96)",
          boxShadow:
            "0 12px 32px rgba(59,130,246,0.25), 0 4px 12px rgba(0,0,0,0.20)",
        }}
      >
        <button
          type="button"
          onClick={onOpenParking}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold active:scale-95"
          style={{
            background: "linear-gradient(90deg, #3b82f6, #6366f1)",
            color: "#fff",
          }}
          aria-label="Show parking suggestions near your destination"
        >
          <ParkingCircle className="w-3.5 h-3.5" />
          Need parking?
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex items-center justify-center w-7 h-7 rounded-full transition-colors"
          style={{ color: "var(--panel-text-muted)" }}
          aria-label="Dismiss parking suggestion"
          title="Not now"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
