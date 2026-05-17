"use client";

/** "Find nearby" category chips + result list.
 *
 *  A passive, ambient affordance — same shelf as Google Maps' chip
 *  row under the search bar ("Restaurants · Hotels · Gas"). User
 *  taps a category, we Overpass-query around their current location
 *  (or, falling back, the active city center), and render the closest
 *  matches inline. Tapping a result flies to it; long-pressing
 *  delegates to the parent's onDirections so the user can route there.
 *
 *  Not mounted while the user is typing a search — the parent decides
 *  visibility. */

import { useEffect, useRef, useState } from "react";
import { Coffee, Utensils, Cross, Pill, Fuel, ParkingSquare, Banknote, Train, Loader2, MapPin } from "lucide-react";
import { POI_CATEGORIES, searchPOI, type PoiResult } from "@/lib/poi";
import { getCurrentCity } from "@/lib/pulse-cities";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  coffee: Coffee,
  food: Utensils,
  hospital: Cross,
  pharmacy: Pill,
  gas: Fuel,
  parking: ParkingSquare,
  atm: Banknote,
  transit: Train,
};

interface Props {
  /** User's current location, if known. When null we fall back to the
   *  active city's center so the user still sees *something* before
   *  granting geolocation. */
  userPos?: { lat: number; lng: number } | null;
  onFlyTo: (lat: number, lng: number) => void;
  /** Optional — when supplied, results show a "→ directions" affordance.
   *  Signature matches SearchSidebar.openDirections: (destName, destCoords). */
  onDirections?: (destName: string, destCoords: { lat: number; lng: number }) => void;
}

function formatDistance(m?: number): string {
  if (m == null) return "";
  if (m < 1000) return `${m} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

export default function NearbyChips({ userPos, onFlyTo, onDirections }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const [results, setResults] = useState<PoiResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Centre for the search: prefer real GPS, fall back to city center.
  // The fallback isn't useless — it still returns "popular coffee
  // shops in Center City" or similar, which beats a blank state.
  const origin = userPos ?? (() => {
    const c = getCurrentCity();
    return { lat: c.lat, lng: c.lng };
  })();

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handlePick = async (key: string) => {
    if (active === key) {
      // Tap the same chip again = collapse.
      setActive(null);
      setResults([]);
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setActive(key);
    setResults([]);
    setErr(null);
    setLoading(true);
    try {
      const r = await searchPOI(key, origin.lat, origin.lng, {
        radiusM: 2500,
        limit: 12,
        signal: ctrl.signal,
      });
      if (!ctrl.signal.aborted) setResults(r);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setErr(e instanceof Error ? e.message : "search failed");
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  };

  return (
    <div className="px-4 pb-2">
      <div
        className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1"
        style={{ scrollbarWidth: "none" }}
      >
        {POI_CATEGORIES.map((c) => {
          const Icon = ICONS[c.key] ?? MapPin;
          const isActive = active === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => handlePick(c.key)}
              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors"
              style={{
                background: isActive
                  ? "rgba(59,130,246,0.18)"
                  : "var(--panel-input-bg, rgba(255,255,255,0.05))",
                color: isActive ? "#3b82f6" : "var(--panel-text)",
                border: `1px solid ${
                  isActive
                    ? "rgba(59,130,246,0.55)"
                    : "var(--panel-input-border, rgba(255,255,255,0.08))"
                }`,
              }}
              aria-pressed={isActive}
            >
              <Icon className="w-3 h-3" />
              {c.label}
            </button>
          );
        })}
      </div>

      {active && (
        <div className="mt-2 space-y-0.5 max-h-[40vh] overflow-y-auto">
          {loading && (
            <div
              className="flex items-center gap-1.5 text-[11px] py-1.5 px-1"
              style={{ color: "var(--panel-text-muted, #9ca3af)" }}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              Searching nearby…
            </div>
          )}

          {err && !loading && (
            <div
              className="text-[11px] py-1 px-1"
              style={{ color: "#ef4444" }}
            >
              Couldn&apos;t reach OpenStreetMap. Try again in a few seconds.
            </div>
          )}

          {!loading && !err && results.length === 0 && (
            <div
              className="text-[11px] py-1 px-1"
              style={{ color: "var(--panel-text-muted, #9ca3af)" }}
            >
              Nothing in this category within 2.5 km.
            </div>
          )}

          {results.map((r, i) => (
            <div
              key={`${r.lat}-${r.lng}-${i}`}
              className="flex items-center gap-2 py-1.5 px-1 rounded-md hover:bg-white/[0.04] transition-colors"
            >
              <button
                type="button"
                onClick={() => onFlyTo(r.lat, r.lng)}
                className="flex-1 flex items-center gap-2 min-w-0 text-left"
              >
                <MapPin
                  className="w-3 h-3 shrink-0"
                  style={{ color: "var(--panel-text-muted, #9ca3af)" }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12px] truncate"
                    style={{ color: "var(--panel-text)" }}
                  >
                    {r.name}
                  </div>
                  {r.subtitle && (
                    <div
                      className="text-[10px] truncate"
                      style={{ color: "var(--panel-text-muted, #9ca3af)" }}
                    >
                      {r.subtitle}
                    </div>
                  )}
                </div>
                <span
                  className="text-[10px] font-mono tabular-nums shrink-0"
                  style={{ color: "var(--panel-text-muted, #9ca3af)" }}
                >
                  {formatDistance(r.meters)}
                </span>
              </button>
              {onDirections && (
                <button
                  type="button"
                  onClick={() => onDirections(r.name, { lat: r.lat, lng: r.lng })}
                  className="shrink-0 px-2 py-0.5 rounded-md text-[10px] font-medium"
                  style={{
                    background: "rgba(59,130,246,0.12)",
                    color: "#3b82f6",
                    border: "1px solid rgba(59,130,246,0.3)",
                  }}
                  aria-label={`Get directions to ${r.name}`}
                >
                  Route
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
