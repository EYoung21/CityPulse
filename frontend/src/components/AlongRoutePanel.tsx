"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MapPin, Plus, Search, X } from "lucide-react";
import { fetchPoisInBounds, NEARBY_POI_CATEGORIES, type NearbyPoiCategory } from "@/lib/overpass";
import { polylineBbox, rankAlongRoute, type AlongRoutePoi, type RoutePoint } from "@/lib/along-route";

interface Props {
  /** Active trip polyline as `[lat, lng]` pairs. Search-along-route
   *  is hidden while this is empty. */
  geometry: [number, number][] | null;
  /** Current GPS location, used to display "X away" for the user
   *  rather than only the POI's distance from the route. */
  userLocation: { lat: number; lng: number } | null;
  /** Close handler — also fires when the user picks an action. */
  onClose: () => void;
}

interface FetchState {
  category: NearbyPoiCategory | null;
  loading: boolean;
  results: AlongRoutePoi[];
  error: string | null;
}

function fmtMeters(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 5000 ? 1 : 0)} km`;
}

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(x));
}

/** "Search along route" panel — surfaces gas / food / coffee / ATM /
 *  parking / EV / restroom POIs that fall within ~500m of the active
 *  trip's polyline, ranked by detour cost.
 *
 *  Tap a POI to add it as a stop in SearchSidebar (via the
 *  `pp:add-stop` event); SearchSidebar then re-routes through it.
 *  This is the closest analogue to Google Maps' "Search along route"
 *  drawer that we can build without paid routing APIs.
 */
export default function AlongRoutePanel({ geometry, userLocation, onClose }: Props) {
  const [state, setState] = useState<FetchState>({
    category: null,
    loading: false,
    results: [],
    error: null,
  });
  const fetchSeqRef = useRef(0);

  // Memoize the polyline shape so the rank step doesn't recompute on
  // every render — geometry comes in as a fresh array reference each
  // time `tripGeometry` updates upstream.
  const polyline = useMemo<RoutePoint[]>(() => {
    if (!geometry) return [];
    return geometry.map(([lat, lng]) => ({ lat, lng }));
  }, [geometry]);

  const pickCategory = async (cat: NearbyPoiCategory) => {
    if (polyline.length < 2) return;
    const seq = ++fetchSeqRef.current;
    setState({ category: cat, loading: true, results: [], error: null });
    try {
      const bbox = polylineBbox(polyline, 600);
      if (!bbox) throw new Error("Empty route");
      // Slightly higher fetch limit since we're going to filter most
      // of these out by perpendicular distance.
      const raw = await fetchPoisInBounds(cat, bbox, 120);
      if (seq !== fetchSeqRef.current) return;
      const ranked = rankAlongRoute(
        polyline,
        raw.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng })),
        { maxPerpM: 500, maxResults: 12 }
      );
      setState({ category: cat, loading: false, results: ranked, error: null });
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      setState({
        category: cat,
        loading: false,
        results: [],
        error: err instanceof Error ? err.message : "Search failed",
      });
    }
  };

  const handleAddStop = (poi: AlongRoutePoi) => {
    window.dispatchEvent(
      new CustomEvent("pp:add-stop", {
        detail: {
          name: poi.name,
          lat: poi.lat,
          lng: poi.lng,
        },
      })
    );
    onClose();
  };

  // Esc to close (matches the rest of our overlay panels).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-x-0 z-[1100] flex justify-center px-3"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 5.5rem)" }}
    >
      <div
        className="w-full max-w-md rounded-2xl shadow-2xl backdrop-blur-xl overflow-hidden"
        style={{
          background: "var(--panel-bg)",
          border: "1px solid var(--panel-border)",
        }}
        role="dialog"
        aria-label="Search along route"
      >
        <div className="px-3 py-2.5 flex items-center gap-2" style={{ borderBottom: "1px solid var(--panel-border)" }}>
          <Search className="w-4 h-4" style={{ color: "var(--panel-text-secondary)" }} />
          <h2 className="text-sm font-semibold flex-1" style={{ color: "var(--panel-text)" }}>
            Search along route
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

        {/* Category chips. Same set as the Layers Nearby section so the
            user sees the same vocabulary in both places. */}
        <div className="flex gap-1.5 overflow-x-auto px-3 py-2 no-scrollbar">
          {NEARBY_POI_CATEGORIES.map((c) => {
            const active = state.category === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => void pickCategory(c.id)}
                className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${active ? "" : "hover:opacity-80"}`}
                style={
                  active
                    ? { background: c.color, color: "#fff" }
                    : { background: "var(--panel-input-bg)", color: "var(--panel-text-secondary)" }
                }
              >
                <span aria-hidden="true">{c.emoji}</span>
                {c.label}
              </button>
            );
          })}
        </div>

        {/* Results */}
        <div
          className="max-h-[40vh] overflow-y-auto"
          style={{ borderTop: "1px solid var(--panel-border)" }}
        >
          {!state.category && (
            <p className="px-3 py-6 text-center text-xs" style={{ color: "var(--panel-text-muted)" }}>
              Pick a category to find stops within ~500 m of your route.
            </p>
          )}
          {state.loading && (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs" style={{ color: "var(--panel-text-muted)" }}>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Searching the next {polyline.length > 0 ? "stretch" : "route"}…
            </div>
          )}
          {state.error && (
            <p className="px-3 py-4 text-xs text-rose-400">{state.error}</p>
          )}
          {!state.loading && state.category && state.results.length === 0 && !state.error && (
            <p className="px-3 py-6 text-center text-xs" style={{ color: "var(--panel-text-muted)" }}>
              Nothing nearby. Try widening to another category.
            </p>
          )}
          {state.results.length > 0 && (
            <ul className="divide-y" style={{ borderColor: "var(--panel-border)" }}>
              {state.results.map((poi) => {
                const fromUser = userLocation ? haversineM(userLocation, poi) : null;
                return (
                  <li key={poi.id} className="flex items-start gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate" style={{ color: "var(--panel-text)" }}>
                        {poi.name}
                      </p>
                      <p className="text-[11px] tabular-nums" style={{ color: "var(--panel-text-muted)" }}>
                        +{fmtMeters(poi.detourM)} detour
                        {fromUser != null && ` · ${fmtMeters(fromUser)} away`}
                        {" · "}{fmtMeters(poi.perpM)} off route
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleAddStop(poi)}
                      className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors"
                      style={{
                        background: "linear-gradient(90deg, #3b82f6, #6366f1)",
                        color: "#fff",
                      }}
                      title="Insert as a stop on this trip"
                    >
                      <Plus className="w-3 h-3" />
                      Add stop
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {state.category && state.results.length > 0 && (
          <div
            className="px-3 py-2 text-[10px]"
            style={{
              color: "var(--panel-text-muted)",
              borderTop: "1px solid var(--panel-border)",
              background: "var(--panel-input-bg)",
            }}
          >
            <MapPin className="w-2.5 h-2.5 inline mr-1 -mt-0.5" />
            Detour cost is round-trip from the closest point on your route.
          </div>
        )}
      </div>
    </div>
  );
}
