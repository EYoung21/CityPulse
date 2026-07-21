"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Phone, Shield, Footprints, Car, X, AlertTriangle } from "lucide-react";
import {
  findSafeSpacesNear,
  formatDistance,
  SAFE_PLACE_KIND_META,
  type SafePlace,
} from "@/lib/safety-escape";

interface Props {
  /** Last known GPS location. The panel refuses to show results without
   *  one — telling someone in distress to "drive 4km west" with no map
   *  origin is worse than telling them nothing. */
  userLocation: { lat: number; lng: number } | null;
  onClose: () => void;
}

/** Get-to-safety bottom sheet.
 *
 *  Surfaces the closest staffed safe spaces (police, hospital, fire,
 *  24h gas) plus a one-tap call-911 link. Kept intentionally simple —
 *  in distress you don't want to read a UI, you want a big button to
 *  the closest help.
 *
 *  Tap "Walk" or "Drive" to dispatch the same `pp:plan-route` event the
 *  rest of the app uses; SearchSidebar / DirectionsPanel pick it up
 *  and start a route immediately. We intentionally do _not_ collapse
 *  the panel on a route start so the user can fall back to the next
 *  option without having to re-open the panel.
 */
export default function SafetyEscapePanel({ userLocation, onClose }: Props) {
  const [places, setPlaces] = useState<SafePlace[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    void Promise.resolve().then(async () => {
      if (!userLocation) {
        if (seq !== seqRef.current) return;
        setPlaces([]);
        setError("Need your current location to find help nearby.");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      setPlaces(null);
      try {
        const rows = await findSafeSpacesNear(userLocation);
        if (seq !== seqRef.current) return;
        setPlaces(rows);
        setLoading(false);
      } catch (err) {
        if (seq !== seqRef.current) return;
        setError(err instanceof Error ? err.message : "Search failed");
        setLoading(false);
      }
    });
    return () => {
      if (seq === seqRef.current) seqRef.current += 1;
    };
  }, [userLocation]);

  // Esc to dismiss — matches every other overlay panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const planRoute = (place: SafePlace, mode: "drive" | "walk") => {
    window.dispatchEvent(
      new CustomEvent("pp:plan-route", {
        detail: {
          mode: "to",
          lat: place.lat,
          lng: place.lng,
          label: place.name,
          // SearchSidebar / DirectionsPanel honor a `transport` hint
          // when present so the route starts in the user-chosen mode.
          transport: mode === "walk" ? "foot-walking" : "driving-car",
        },
      })
    );
  };

  return (
    <div
      className="fixed inset-x-0 z-[1200] flex justify-center px-3"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 5.5rem)" }}
      role="dialog"
      aria-label="Get to safety"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-2xl shadow-2xl backdrop-blur-xl overflow-hidden"
        style={{
          background: "var(--panel-bg)",
          border: "1px solid rgba(239,68,68,0.45)",
          boxShadow: "0 12px 48px rgba(239,68,68,0.25), 0 4px 16px rgba(0,0,0,0.3)",
        }}
      >
        {/* Header — the red accent is intentional. This panel only
            opens when the user explicitly taps "safety", so the color
            is reassuring ("yes, this is the help button") rather than
            alarming. */}
        <div
          className="px-3 py-2.5 flex items-center gap-2"
          style={{
            background: "rgba(239,68,68,0.10)",
            borderBottom: "1px solid var(--panel-border)",
          }}
        >
          <Shield className="w-4 h-4" style={{ color: "#ef4444" }} />
          <h2 className="text-sm font-semibold flex-1" style={{ color: "var(--panel-text)" }}>
            Get to safety
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md"
            style={{ color: "var(--panel-text-muted)" }}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Call 911 — top of the sheet so it's reachable without
            scrolling, and visually the loudest control. */}
        <a
          href="tel:911"
          className="flex items-center gap-3 px-3 py-3 transition-colors active:scale-[0.99]"
          style={{
            background: "linear-gradient(90deg, #ef4444, #f97316)",
            color: "#fff",
          }}
        >
          <Phone className="w-5 h-5" />
          <span className="flex-1 text-sm font-semibold">Call 911</span>
          <span className="text-[11px] opacity-80">tap to dial</span>
        </a>

        {/* Body — staffed-place list */}
        <div
          className="max-h-[50vh] overflow-y-auto"
          style={{ borderTop: "1px solid var(--panel-border)" }}
        >
          {loading && (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs" style={{ color: "var(--panel-text-muted)" }}>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Finding the closest safe places…
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-4 text-xs" style={{ color: "#fca5a5" }}>
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!loading && places && places.length === 0 && !error && (
            <p className="px-3 py-6 text-center text-xs" style={{ color: "var(--panel-text-muted)" }}>
              Couldn&rsquo;t find staffed places within 4 km. Try Call 911 above.
            </p>
          )}

          {places && places.length > 0 && (
            <ul className="divide-y" style={{ borderColor: "var(--panel-border)" }}>
              {places.map((place) => {
                const meta = SAFE_PLACE_KIND_META[place.kind];
                return (
                  <li key={place.id} className="px-3 py-2.5">
                    <div className="flex items-start gap-3">
                      <div
                        className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-base"
                        style={{ background: `${meta.color}22`, color: meta.color }}
                        aria-hidden="true"
                      >
                        {meta.emoji}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate" style={{ color: "var(--panel-text)" }}>
                          {place.name}
                        </p>
                        <p className="text-[11px] tabular-nums" style={{ color: "var(--panel-text-muted)" }}>
                          {meta.label} · {formatDistance(place.distanceM)} away
                          {place.hint ? ` · ${place.hint}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => planRoute(place, "walk")}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-colors active:scale-95"
                        style={{
                          background: "var(--panel-input-bg)",
                          color: "var(--panel-text)",
                          border: "1px solid var(--panel-border)",
                        }}
                      >
                        <Footprints className="w-3 h-3" />
                        Walk
                      </button>
                      <button
                        type="button"
                        onClick={() => planRoute(place, "drive")}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-colors active:scale-95"
                        style={{
                          background: "linear-gradient(90deg, #3b82f6, #6366f1)",
                          color: "#fff",
                        }}
                      >
                        <Car className="w-3 h-3" />
                        Drive
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div
          className="px-3 py-2 text-[10px] flex items-center gap-1.5"
          style={{
            color: "var(--panel-text-muted)",
            borderTop: "1px solid var(--panel-border)",
            background: "var(--panel-input-bg)",
          }}
        >
          <Shield className="w-2.5 h-2.5" />
          Hours aren&rsquo;t verified — police &amp; fire are usually 24h, gas may not be.
        </div>
      </div>
    </div>
  );
}
