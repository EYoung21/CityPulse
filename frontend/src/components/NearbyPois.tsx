"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Navigation, MapPin, Clock } from "lucide-react";
import { fetchNearbyPois, POI_CATEGORIES, type Poi, type PoiCategory } from "@/lib/overpass";
import { evaluateOpeningHours, formatOpeningBadge } from "@/lib/opening-hours";

interface Props {
  lat: number;
  lng: number;
  /** Optional callback when the user picks a POI — typically pans the map to it. */
  onSelect?: (poi: Poi) => void;
}

function fmtDistance(m: number): string {
  if (m < 100) return `${Math.round(m / 5) * 5} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** Compact "What's nearby" panel: a horizontal chip strip of POI categories
 *  (Food / Coffee / Gas / Hospital / Pharmacy / Parking / ATM). Picking one
 *  fires an Overpass query and shows the closest 6 results inline.
 *
 *  Embedded in SafetyScoreCard and DroppedPinCard so the user can immediately
 *  answer "what's around me" after dropping a pin. */
export default function NearbyPois({ lat, lng, onSelect }: Props) {
  const [active, setActive] = useState<PoiCategory | null>(null);
  const [results, setResults] = useState<Poi[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setActive(null);
    setResults([]);
  }, [lat, lng]);

  const pick = useCallback(async (cat: PoiCategory) => {
    if (active === cat) {
      setActive(null);
      setResults([]);
      return;
    }
    setActive(cat);
    setLoading(true);
    setResults([]);
    try {
      const pois = await fetchNearbyPois(cat, lat, lng, 1000, 8);
      setResults(pois);
    } finally {
      setLoading(false);
    }
  }, [active, lat, lng]);

  const handleSelect = useCallback((poi: Poi) => {
    onSelect?.(poi);
  }, [onSelect]);

  const handleDirections = useCallback((poi: Poi) => {
    window.dispatchEvent(
      new CustomEvent("pp:plan-route", {
        detail: { mode: "to", lat: poi.lat, lng: poi.lng, label: poi.name },
      })
    );
  }, []);

  return (
    <div>
      <p
        className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 flex items-center gap-1.5"
        style={{ color: "var(--panel-text-muted)" }}
      >
        <MapPin className="w-3 h-3" /> Nearby
      </p>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
        {POI_CATEGORIES.map((c) => {
          const isActive = active === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => pick(c.id)}
              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors active:scale-95"
              style={{
                background: isActive ? "rgba(59,130,246,0.15)" : "var(--panel-input-bg)",
                color: isActive ? "#3b82f6" : "var(--panel-text-secondary)",
                border: `1px solid ${isActive ? "rgba(59,130,246,0.35)" : "var(--panel-border)"}`,
              }}
              aria-pressed={isActive}
            >
              <span aria-hidden>{c.emoji}</span>
              {c.label}
            </button>
          );
        })}
      </div>

      {active && (
        <div
          className="mt-2 rounded-lg overflow-hidden"
          style={{ background: "var(--panel-input-bg)", border: "1px solid var(--panel-border)" }}
        >
          {loading ? (
            <div className="px-3 py-3 flex items-center gap-2 text-xs" style={{ color: "var(--panel-text-muted)" }}>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Searching nearby…
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-xs" style={{ color: "var(--panel-text-muted)" }}>
              Nothing within 1 km. Try zooming out and dropping a new pin.
            </div>
          ) : (
            results.map((poi, i) => {
              const badge = formatOpeningBadge(evaluateOpeningHours(poi.openingHours));
              const badgeColor =
                badge?.tone === "open" || badge?.tone === "always"
                  ? "#22c55e"
                  : badge?.tone === "closing-soon"
                    ? "#f59e0b"
                    : "#94a3b8";
              return (
              <div
                key={poi.id}
                onClick={() => handleSelect(poi)}
                className="flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors"
                style={{
                  borderBottom: i < results.length - 1 ? "1px solid var(--panel-border)" : "none",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate" style={{ color: "var(--panel-text)" }} title={poi.name}>
                    {poi.name}
                  </p>
                  <p className="text-[10px] truncate flex items-center gap-1" style={{ color: "var(--panel-text-muted)" }}>
                    <span>{fmtDistance(poi.distance)}</span>
                    {poi.hint && <><span aria-hidden="true">·</span><span className="truncate">{poi.hint}</span></>}
                    {badge && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span
                          className="inline-flex items-center gap-0.5"
                          style={{ color: badgeColor }}
                          title={poi.openingHours}
                        >
                          <Clock className="w-2.5 h-2.5" />
                          {badge.label}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDirections(poi);
                  }}
                  className="shrink-0 p-1.5 rounded-md text-blue-500/60 hover:text-blue-500"
                  title={`Directions to ${poi.name}`}
                  aria-label={`Get directions to ${poi.name}`}
                >
                  <Navigation className="w-3.5 h-3.5" />
                </button>
              </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
