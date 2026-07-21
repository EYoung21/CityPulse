"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Navigation, MapPin, Clock, Phone, Globe, Accessibility } from "lucide-react";
import { fetchNearbyPois, POI_CATEGORIES, type Poi, type PoiCategory } from "@/lib/overpass";
import { evaluateOpeningHours, formatOpeningBadge } from "@/lib/opening-hours";
import { normalizeHttpUrl } from "@/lib/safe-url";

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
 *  Embedded in SafetyScoreCard so the user can immediately
 *  answer "what's around me" after dropping a pin. */
export default function NearbyPois({ lat, lng, onSelect }: Props) {
  const [active, setActive] = useState<PoiCategory | null>(null);
  const [results, setResults] = useState<Poi[]>([]);
  const [loading, setLoading] = useState(false);
  /** When true, results without an explicit "open now" verdict are
   *  hidden. Places without an `opening_hours` tag stay visible — we
   *  can't tell if they're open or not, and silently dropping them
   *  would feel like the data is missing. */
  const [openNowOnly, setOpenNowOnly] = useState(false);
  const requestGeneration = useRef(0);

  useEffect(() => {
    requestGeneration.current += 1;
    setActive(null);
    setResults([]);
    setOpenNowOnly(false);
    return () => {
      requestGeneration.current += 1;
    };
  }, [lat, lng]);

  const visibleResults = useMemo(() => {
    if (!openNowOnly) return results;
    return results.filter((poi) => {
      if (!poi.openingHours) return true;
      const status = evaluateOpeningHours(poi.openingHours);
      return status?.status === "open" || status?.status === "always";
    });
  }, [results, openNowOnly]);

  const pick = useCallback(async (cat: PoiCategory) => {
    const generation = ++requestGeneration.current;
    if (active === cat) {
      setActive(null);
      setResults([]);
      setLoading(false);
      return;
    }
    setActive(cat);
    setLoading(true);
    setResults([]);
    try {
      const pois = await fetchNearbyPois(cat, lat, lng, 1000, 8);
      if (requestGeneration.current === generation) setResults(pois);
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
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
        {active && (
          <button
            type="button"
            onClick={() => setOpenNowOnly((v) => !v)}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors active:scale-95"
            style={{
              background: openNowOnly ? "rgba(34,197,94,0.15)" : "var(--panel-input-bg)",
              color: openNowOnly ? "#22c55e" : "var(--panel-text-secondary)",
              border: `1px solid ${openNowOnly ? "rgba(34,197,94,0.35)" : "var(--panel-border)"}`,
            }}
            aria-pressed={openNowOnly}
            title="Hide places that OSM marks as currently closed (untagged places stay visible)"
          >
            <Clock className="w-3 h-3" />
            Open now
          </button>
        )}
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
          ) : visibleResults.length === 0 ? (
            <div className="px-3 py-3 text-xs" style={{ color: "var(--panel-text-muted)" }}>
              {results.length === 0
                ? "Nothing within 1 km. Try zooming out and dropping a new pin."
                : "All nearby places are closed right now. Toggle Open now off to see them."}
            </div>
          ) : (
            visibleResults.map((poi, i) => {
              const safeWebsite = normalizeHttpUrl(poi.website);
              const safePhone = poi.phone?.replace(/[^\d+*#,;]/g, "") ?? "";
              const badge = formatOpeningBadge(evaluateOpeningHours(poi.openingHours));
              const badgeColor =
                badge?.tone === "open" || badge?.tone === "always"
                  ? "#22c55e"
                  : badge?.tone === "closing-soon"
                    ? "#f59e0b"
                    : "#94a3b8";
              const wheelchairColor =
                poi.wheelchair === "yes"
                  ? "#22c55e"
                  : poi.wheelchair === "limited"
                    ? "#f59e0b"
                    : "#ef4444";
              const wheelchairLabel =
                poi.wheelchair === "yes"
                  ? "Step-free access"
                  : poi.wheelchair === "limited"
                    ? "Limited accessibility"
                    : "Not wheelchair-accessible";
              return (
              <div
                key={poi.id}
                className="flex items-center gap-2 px-3 py-2 transition-colors"
                style={{
                  borderBottom: i < visibleResults.length - 1 ? "1px solid var(--panel-border)" : "none",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <button
                  type="button"
                  onClick={() => handleSelect(poi)}
                  className="min-w-0 flex-1 text-left"
                  aria-label={`Show ${poi.name} on map`}
                >
                  <p className="text-xs font-medium truncate flex items-center gap-1.5" style={{ color: "var(--panel-text)" }} title={poi.name}>
                    <span className="truncate">{poi.name}</span>
                    {poi.wheelchair && (
                      <span
                        className="shrink-0 inline-flex items-center"
                        style={{ color: wheelchairColor }}
                        title={wheelchairLabel}
                        aria-label={wheelchairLabel}
                      >
                        <Accessibility className="w-3 h-3" />
                      </span>
                    )}
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
                </button>
                {safePhone && (
                  <a
                    href={`tel:${safePhone}`}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 p-1.5 rounded-md text-emerald-500/70 hover:text-emerald-500"
                    title={`Call ${poi.name}`}
                    aria-label={`Call ${poi.name}`}
                  >
                    <Phone className="w-3.5 h-3.5" />
                  </a>
                )}
                {safeWebsite && (
                  <a
                    href={safeWebsite}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 p-1.5 rounded-md text-indigo-500/70 hover:text-indigo-500"
                    title={`Open website for ${poi.name}`}
                    aria-label={`Open website for ${poi.name}`}
                  >
                    <Globe className="w-3.5 h-3.5" />
                  </a>
                )}
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
