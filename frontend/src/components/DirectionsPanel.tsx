"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  MapPin,
  Footprints,
  Bike,
  Car,
  Loader2,
  LocateFixed,
  X,
  ArrowUpDown,
  ChevronLeft,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Play,
  Star,
  Plus,
} from "lucide-react";
import { geocodePhilly } from "@/lib/search";
import { useSavedDestinations } from "@/hooks/useSavedDestinations";
import {
  getRouteOptions,
  buildAvoidZones,
  buildAvoidPolygons,
  type TransportMode,
  type AvoidancePrefs,
  type RouteOption,
} from "@/lib/routing";
import type { Incident } from "@/lib/api";
import type { RouteData } from "@/components/RoutePanel";
import type { WaypointPin } from "@/components/IncidentMap";
import RouteOptionPicker from "@/components/RouteOptionPicker";
import AvoidancePrefsPicker from "@/components/AvoidancePrefsPicker";
import { loadRecent, type RecentSearch } from "@/lib/recent-searches";
import { Clock as ClockIcon } from "lucide-react";

const ORS_API_KEY =
  process.env.NEXT_PUBLIC_ORS_KEY || "5b3ce3597851110001cf6248a1b2c3d4e5f6a7b8";

const MODES: { id: TransportMode; label: string; icon: typeof Footprints }[] = [
  { id: "foot-walking", label: "Walking", icon: Footprints },
  { id: "cycling-regular", label: "Cycling", icon: Bike },
  { id: "driving-car", label: "Driving", icon: Car },
];

const STOP_COLORS = ["#f97316", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"];

interface StopLoc {
  display_name: string;
  lat: number;
  lng: number;
}

interface Props {
  incidents: Incident[];
  originLoc: StopLoc | null;
  setOriginLoc: (loc: StopLoc | null) => void;
  originQuery: string;
  setOriginQuery: (q: string) => void;
  destLoc: StopLoc | null;
  setDestLoc: (loc: StopLoc | null) => void;
  destQuery: string;
  setDestQuery: (q: string) => void;
  stops: { query: string; loc: StopLoc | null }[];
  setStops: (s: { query: string; loc: StopLoc | null }[]) => void;
  activeMode: TransportMode;
  setActiveMode: (m: TransportMode) => void;
  userPos: { lat: number; lng: number } | null;
  gpsStatus: "idle" | "loading" | "found" | "denied";
  onBack: () => void;
  onFlyTo: (lat: number, lng: number) => void;
  onRoutesChange: (routes: RouteData | null) => void;
  onPreviewPins?: (
    origin: { lat: number; lng: number } | null,
    dest: { lat: number; lng: number } | null
  ) => void;
  onPreviewWaypoints?: (waypoints: WaypointPin[] | null) => void;
  onStartTrip: () => Promise<void>;
  avoidPrefs: AvoidancePrefs;
  onAvoidPrefsChange: (prefs: AvoidancePrefs) => void;
  /** Hours of incident history currently feeding routing (driven by the
   *  global time-filter slider). Used purely for the long-window
   *  inline note. */
  timeFilterHours: number;
}

export default function DirectionsPanel({
  incidents,
  originLoc,
  setOriginLoc,
  originQuery,
  setOriginQuery,
  destLoc,
  setDestLoc,
  destQuery,
  setDestQuery,
  stops,
  setStops,
  activeMode,
  setActiveMode,
  userPos,
  gpsStatus,
  onBack,
  onFlyTo,
  onRoutesChange,
  onPreviewPins,
  onPreviewWaypoints,
  onStartTrip,
  avoidPrefs,
  onAvoidPrefsChange,
  timeFilterHours,
}: Props) {
  /** Compact label for a duration in hours, used by the long-window
   *  note ("3mo", "1w", "12h", etc.). Mirrors the TIME_FILTERS labels
   *  in page.tsx but avoids needing to thread that constant down. */
  const fmtWindow = (h: number): string => {
    if (h >= 720) return `${Math.round(h / 720)}mo`;
    if (h >= 168) return `${Math.round(h / 168)}w`;
    if (h >= 24) return `${Math.round(h / 24)}d`;
    if (h >= 1) return `${Math.round(h)}h`;
    return `${Math.round(h * 60)}m`;
  };
  const [originSuggestions, setOriginSuggestions] = useState<StopLoc[]>([]);
  const [destSuggestions, setDestSuggestions] = useState<StopLoc[]>([]);
  const [stopSuggestions, setStopSuggestions] = useState<StopLoc[]>([]);
  const [originLoading, setOriginLoading] = useState(false);
  const [destLoading, setDestLoading] = useState(false);
  const [stopLoading, setStopLoading] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState<"origin" | "dest" | null>(null);
  const [activeStopIdx, setActiveStopIdx] = useState<number | null>(null);
  const [previewRoute, setPreviewRoute] = useState<{
    distanceKm: number;
    durationMin: number;
    isSafe: boolean;
    nearbyCount: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([]);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [startNavBusy, setStartNavBusy] = useState(false);
  // Recent destinations strip — populated from the same localStorage
  // ring the search box uses, so picking somewhere in the search shows
  // up here too. Hidden once a destination is chosen.
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  useEffect(() => {
    setRecents(loadRecent());
    const onStorage = (e: StorageEvent) => {
      if (e.key === "pp:recent-searches") setRecents(loadRecent());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const previewAbortRef = useRef<AbortController | null>(null);
  const incidentsRef = useRef(incidents);
  incidentsRef.current = incidents;

  const { destinations: savedDests, canSave, addDestination } = useSavedDestinations();

  const geocode = useCallback(
    async (
      q: string,
      setter: (r: StopLoc[]) => void,
      loadingSetter: (b: boolean) => void
    ) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (q.trim().length < 2) {
        setter([]);
        loadingSetter(false);
        return;
      }
      loadingSetter(true);
      debounceRef.current = setTimeout(async () => {
        const results = await geocodePhilly(q);
        setter(results);
        loadingSetter(false);
      }, 200);
    },
    []
  );

  const allWaypoints = useCallback((): { label: string; loc: StopLoc }[] => {
    const result: { label: string; loc: StopLoc }[] = [];
    if (originLoc) result.push({ label: "A", loc: originLoc });
    stops.forEach((s, i) => {
      if (s.loc) result.push({ label: String.fromCharCode(66 + i), loc: s.loc });
    });
    if (destLoc) result.push({ label: String.fromCharCode(66 + stops.length), loc: destLoc });
    return result;
  }, [originLoc, destLoc, stops]);

  const syncPreviewPins = useCallback(() => {
    const wps = allWaypoints();
    if (wps.length >= 2) {
      const pins: WaypointPin[] = wps.map((wp, i) => ({
        label: wp.label,
        lat: wp.loc.lat,
        lng: wp.loc.lng,
        color:
          i === 0
            ? "#22c55e"
            : i === wps.length - 1
              ? "#ef4444"
              : STOP_COLORS[(i - 1) % STOP_COLORS.length],
        glowColor:
          i === 0
            ? "rgba(34,197,94,0.5)"
            : i === wps.length - 1
              ? "rgba(239,68,68,0.5)"
              : STOP_COLORS[(i - 1) % STOP_COLORS.length] + "80",
      }));
      onPreviewWaypoints?.(pins);
    } else {
      onPreviewWaypoints?.(null);
    }
  }, [allWaypoints, onPreviewWaypoints]);

  useEffect(() => {
    syncPreviewPins();
  }, [originLoc, destLoc, stops, syncPreviewPins]);

  useEffect(() => {
    if (!originLoc || !destLoc) {
      setPreviewRoute(null);
      return;
    }
    const intermediateReady = stops.every((s) => s.query.trim() === "" || s.loc !== null);
    if (!intermediateReady) {
      setPreviewRoute(null);
      return;
    }

    if (previewAbortRef.current) previewAbortRef.current.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;

    setPreviewLoading(true);
    setRouteError(null);

    const waypoints: [number, number][] = [
      [originLoc.lat, originLoc.lng],
      ...stops.filter((s) => s.loc).map((s) => [s.loc!.lat, s.loc!.lng] as [number, number]),
      [destLoc.lat, destLoc.lng],
    ];
    const incSnap = incidentsRef.current;
    (async () => {
      try {
        const zones = buildAvoidZones(incSnap, avoidPrefs);
        const avoidPolygons = zones.length > 0 ? buildAvoidPolygons(zones) : null;

        const opts = await getRouteOptions({
          apiKey: ORS_API_KEY,
          mode: activeMode,
          waypoints,
          avoidPolygons,
          includeRoadFeatureVariants: true,
        });
        if (controller.signal.aborted) return;

        if (opts.length === 0) {
          onRoutesChange(null);
          setRouteOptions([]);
          setSelectedOptionId(null);
          setPreviewRoute(null);
          setRouteError("Could not load a street route. Check your network or try another mode.");
          return;
        }

        // Default selection: keep prior choice if still present, otherwise
        // pick whatever sorted to the top (safer, then fastest).
        const keepPrior =
          selectedOptionId && opts.find((o) => o.id === selectedOptionId);
        const chosen = keepPrior || opts[0];
        setRouteOptions(opts);
        setSelectedOptionId(chosen.id);

        const directRoute = opts.find((o) => !o.isSafer && o.avoidedFeatures.length === 0)?.route ?? opts[0].route;
        const saferRoute = opts.find((o) => o.isSafer)?.route ?? null;

        onRoutesChange({
          normal: directRoute,
          safe: saferRoute,
          avoidZones: zones,
          chosen: chosen.route,
          chosenLabel: chosen.label,
        });
        setPreviewRoute({
          distanceKm: chosen.route.distanceKm,
          durationMin: chosen.route.durationMin,
          isSafe: chosen.isSafer,
          nearbyCount: zones.length,
        });
        setRouteError(null);
      } catch {
        if (!controller.signal.aborted) {
          setPreviewRoute(null);
          setRouteOptions([]);
          setSelectedOptionId(null);
          onRoutesChange(null);
          setRouteError("Routing request failed.");
        }
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    })();

    return () => controller.abort();
  }, [originLoc, destLoc, stops, activeMode, onRoutesChange, avoidPrefs]);

  const swapLocations = () => {
    const tmpQ = originQuery;
    const tmpL = originLoc;
    setOriginQuery(destQuery);
    setOriginLoc(destLoc);
    setDestQuery(tmpQ);
    setDestLoc(tmpL);
    onPreviewPins?.(destLoc, tmpL);
  };

  const handleStartTrip = async () => {
    setStartNavBusy(true);
    try {
      await onStartTrip();
    } finally {
      setStartNavBusy(false);
    }
  };

  /** Update which alternative is highlighted on the map and which one
   *  becomes the trip when GO is pressed. */
  const handleSelectRouteOption = useCallback(
    (id: string) => {
      const opt = routeOptions.find((o) => o.id === id);
      if (!opt) return;
      setSelectedOptionId(id);
      const direct =
        routeOptions.find((o) => !o.isSafer && o.avoidedFeatures.length === 0)?.route ??
        routeOptions[0].route;
      const safer = routeOptions.find((o) => o.isSafer)?.route ?? null;
      const zones = buildAvoidZones(incidentsRef.current, avoidPrefs);
      onRoutesChange({
        normal: direct,
        safe: safer,
        avoidZones: zones,
        chosen: opt.route,
        chosenLabel: opt.label,
      });
      setPreviewRoute({
        distanceKm: opt.route.distanceKm,
        durationMin: opt.route.durationMin,
        isSafe: opt.isSafer,
        nearbyCount: zones.length,
      });
    },
    [routeOptions, avoidPrefs, onRoutesChange]
  );

  const renderSuggestion = (
    s: StopLoc,
    i: number,
    onSelect: () => void
  ) => {
    const parts = s.display_name.split(",");
    const primary = parts[0].trim();
    const secondary = parts.slice(1, 3).map((p) => p.trim()).join(", ");
    return (
      <div
        key={i}
        onClick={onSelect}
        className="w-full text-left px-4 py-3 flex items-start gap-3 last:border-0 transition-colors cursor-pointer"
        style={{ borderBottom: "1px solid var(--panel-border)" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ background: "var(--panel-input-bg)" }}
        >
          <MapPin className="w-4 h-4" style={{ color: "var(--panel-text-muted)" }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate" style={{ color: "var(--panel-text)" }}>
            {primary}
          </p>
          {secondary && (
            <p className="text-xs truncate mt-0.5" style={{ color: "var(--panel-text-muted)" }}>
              {secondary}
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div
        className="flex items-center gap-2 px-3 py-3"
        style={{ borderBottom: "1px solid var(--panel-border)" }}
      >
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg transition-colors"
          style={{ color: "var(--panel-text-secondary)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <span className="text-sm font-medium" style={{ color: "var(--panel-text)" }}>
          Directions
        </span>
      </div>

      <div className="flex" style={{ borderBottom: "1px solid var(--panel-border)" }}>
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = activeMode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => setActiveMode(m.id)}
              className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-medium transition-all border-b-2 ${
                active ? "border-blue-500 text-blue-500" : "border-transparent"
              }`}
              style={!active ? { color: "var(--panel-text-secondary)" } : {}}
            >
              <Icon className="w-5 h-5" />
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Avoidance preferences (per-leaf categories + severity floor) */}
      <AvoidancePrefsPicker prefs={avoidPrefs} onChange={onAvoidPrefsChange} />

      {/* Long-window note: routing currently consumes whatever the global
          time filter is showing (5m up through 3mo). Past ~1w of history
          the avoid set explodes — the merger handles it but detours can
          balloon, so heads-up the user. */}
      {timeFilterHours > 168 && avoidPrefs.leaves.size > 0 && (
        <div
          className="px-4 py-2 text-[11px]"
          style={{
            background: "rgba(245,158,11,0.08)",
            color: "var(--panel-text-secondary)",
            borderBottom: "1px solid var(--panel-border)",
          }}
        >
          Routing around incidents from the last {fmtWindow(timeFilterHours)}.
          Long windows can produce big detours.
        </div>
      )}

      <div className="p-4">
        <div className="flex gap-2">
          <div className="flex flex-col items-center pt-3 gap-0">
            <div className="w-3 h-3 rounded-full bg-green-500 ring-4 ring-green-500/20" />
            {stops.map((_, i) => (
              <div key={`dot-${i}`} className="contents">
                <div className="w-0.5 flex-1 my-1" style={{ background: "var(--panel-border)" }} />
                <div
                  className="w-3 h-3 rounded-full ring-4"
                  style={{
                    backgroundColor: STOP_COLORS[i % STOP_COLORS.length],
                    ["--tw-ring-color" as string]: STOP_COLORS[i % STOP_COLORS.length] + "30",
                  }}
                />
              </div>
            ))}
            <div className="w-0.5 flex-1 my-1" style={{ background: "var(--panel-border)" }} />
            <div className="w-3 h-3 rounded-full bg-red-500 ring-4 ring-red-500/20" />
          </div>

          <div className="flex-1 space-y-2">
            <div className="relative">
              <input
                type="text"
                value={originQuery}
                onChange={(e) => {
                  setOriginQuery(e.target.value);
                  setOriginLoc(null);
                  setActiveDropdown("origin");
                  geocode(e.target.value, setOriginSuggestions, setOriginLoading);
                }}
                onFocus={() => {
                  setActiveDropdown("origin");
                  if (originQuery.length >= 2 && !originLoc)
                    geocode(originQuery, setOriginSuggestions, setOriginLoading);
                }}
                placeholder="A · Starting point"
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus:ring-2 focus:ring-blue-500/30"
                style={{
                  background: "var(--panel-input-bg)",
                  border: "1px solid var(--panel-input-border)",
                  color: "var(--panel-text)",
                }}
              />
              {originLoc && (
                <button
                  onClick={() => {
                    setOriginLoc(null);
                    setOriginQuery("");
                    onRoutesChange(null);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              {!originLoc && gpsStatus === "found" && (
                <button
                  onClick={() => {
                    setOriginLoc({ display_name: "Your location", ...userPos! });
                    setOriginQuery("Your location");
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-blue-500/50 hover:text-blue-500"
                  title="Use my location"
                >
                  <LocateFixed className="w-4 h-4" />
                </button>
              )}
            </div>

            {stops.map((stop, idx) => (
              <div key={idx} className="relative flex gap-1">
                <input
                  type="text"
                  value={stop.query}
                  onChange={(e) => {
                    const next = [...stops];
                    next[idx] = { ...next[idx], query: e.target.value, loc: null };
                    setStops(next);
                    setActiveStopIdx(idx);
                    setActiveDropdown(null);
                    geocode(e.target.value, setStopSuggestions, setStopLoading);
                  }}
                  onFocus={() => {
                    setActiveStopIdx(idx);
                    if (stop.query.length >= 2 && !stop.loc)
                      geocode(stop.query, setStopSuggestions, setStopLoading);
                  }}
                  placeholder={`${String.fromCharCode(66 + idx)} · Stop`}
                  className="flex-1 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus:ring-2 focus:ring-blue-500/30"
                  style={{
                    background: "var(--panel-input-bg)",
                    border: "1px solid var(--panel-input-border)",
                    color: "var(--panel-text)",
                  }}
                />
                <button
                  onClick={() => {
                    setStops(stops.filter((_, i) => i !== idx));
                    onRoutesChange(null);
                  }}
                  className="p-1.5 rounded-lg self-center"
                  style={{ color: "var(--panel-text-muted)" }}
                  title="Remove stop"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}

            <div className="relative">
              <input
                type="text"
                value={destQuery}
                onChange={(e) => {
                  setDestQuery(e.target.value);
                  setDestLoc(null);
                  setActiveDropdown("dest");
                  geocode(e.target.value, setDestSuggestions, setDestLoading);
                }}
                onFocus={() => {
                  setActiveDropdown("dest");
                  if (destQuery.length >= 2 && !destLoc)
                    geocode(destQuery, setDestSuggestions, setDestLoading);
                }}
                placeholder={`${String.fromCharCode(66 + stops.length)} · Destination`}
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus:ring-2 focus:ring-blue-500/30"
                style={{
                  background: "var(--panel-input-bg)",
                  border: "1px solid var(--panel-input-border)",
                  color: "var(--panel-text)",
                }}
                autoFocus={!destLoc}
              />
              {destLoc && (
                <button
                  onClick={() => {
                    setDestLoc(null);
                    setDestQuery("");
                    setRouteError(null);
                    onRoutesChange(null);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          <button
            onClick={swapLocations}
            className="self-start mt-3 p-2 rounded-full transition-colors"
            style={{ color: "var(--panel-text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <ArrowUpDown className="w-4 h-4" />
          </button>
        </div>

        {!destLoc && recents.length > 0 && (
          <div className="mt-3">
            <p
              className="text-[10px] uppercase tracking-wider font-semibold mb-1.5 px-1"
              style={{ color: "var(--panel-text-muted)" }}
            >
              Recent
            </p>
            <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
              {recents.slice(0, 6).map((r) => {
                // Compact label: take just the first comma-separated chunk
                // (street name / POI name) so chips stay small.
                const short = r.display_name.split(",")[0]?.trim() || r.display_name;
                return (
                  <button
                    key={`${r.lat},${r.lng},${r.at}`}
                    type="button"
                    onClick={() => {
                      setDestQuery(short);
                      setDestLoc({ display_name: r.display_name, lat: r.lat, lng: r.lng });
                      setActiveDropdown(null);
                    }}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                    style={{
                      background: "var(--panel-input-bg)",
                      border: "1px solid var(--panel-border)",
                      color: "var(--panel-text-secondary)",
                      maxWidth: "200px",
                    }}
                    title={r.display_name}
                  >
                    <ClockIcon className="w-3 h-3 shrink-0" />
                    <span className="truncate">{short}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {stops.length < 5 && (
          <button
            onClick={() => setStops([...stops, { query: "", loc: null }])}
            className="mt-2 flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors rounded-lg"
            style={{ color: "var(--panel-text-secondary)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <Plus className="w-3.5 h-3.5" /> Add stop
          </button>
        )}

        {previewLoading && (
          <div
            className="mt-3 flex items-center gap-2 px-3 py-2.5 rounded-lg"
            style={{ background: "var(--panel-input-bg)" }}
          >
            <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
            <span className="text-xs" style={{ color: "var(--panel-text-secondary)" }}>
              Calculating route...
            </span>
          </div>
        )}

        {routeError && !previewLoading && (
          <div
            className="mt-3 flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs text-red-400"
            style={{ background: "rgba(239,68,68,0.08)" }}
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{routeError}</span>
          </div>
        )}

        {!previewLoading && routeOptions.length > 0 && (
          <div className="mt-3">
            <RouteOptionPicker
              options={routeOptions}
              selectedId={selectedOptionId}
              onSelect={handleSelectRouteOption}
            />
          </div>
        )}

        {previewRoute && !previewLoading && (
          <div
            className="mt-2 rounded-lg overflow-hidden"
            style={{ border: "1px solid var(--panel-border)" }}
          >
            {previewRoute.nearbyCount > 0 && previewRoute.isSafe && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-green-600 dark:text-green-400/80 bg-green-500/5">
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                Safe route avoiding {previewRoute.nearbyCount} incident
                {previewRoute.nearbyCount > 1 ? "s" : ""}
              </div>
            )}
            {previewRoute.nearbyCount > 0 && !previewRoute.isSafe && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-amber-600 dark:text-amber-400/80 bg-amber-500/5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {previewRoute.nearbyCount} incident
                {previewRoute.nearbyCount > 1 ? "s" : ""} near route — pick "Safer" to route around
              </div>
            )}
            {previewRoute.nearbyCount === 0 && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-green-600 dark:text-green-400/80 bg-green-500/5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                Route is clear — no incidents nearby
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <button
            onClick={() => void handleStartTrip()}
            disabled={!originLoc || !destLoc || startNavBusy}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-full text-sm font-semibold transition-all ${
              originLoc && destLoc
                ? startNavBusy
                  ? "bg-blue-500 text-white cursor-wait opacity-90"
                  : "bg-blue-500 hover:bg-blue-400 text-white shadow-lg shadow-blue-500/25 active:scale-[0.98]"
                : "cursor-not-allowed"
            }`}
            style={
              !(originLoc && destLoc)
                ? { background: "var(--panel-input-bg)", color: "var(--panel-text-muted)" }
                : {}
            }
          >
            {startNavBusy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4 fill-current" />
            )}
            {startNavBusy ? "Starting…" : "Start Navigation"}
          </button>
          {canSave && destLoc && (
            <button
              onClick={() => {
                if (destLoc) {
                  void addDestination(destLoc.display_name.split(",")[0], destLoc.lat, destLoc.lng);
                }
              }}
              className="flex items-center justify-center w-12 py-3 rounded-full transition-all border"
              style={{
                background: savedDests.some(
                  (d) =>
                    Math.abs(d.lat - destLoc.lat) < 0.0001 &&
                    Math.abs(d.lng - destLoc.lng) < 0.0001
                )
                  ? "rgba(245,158,11,0.15)"
                  : "var(--panel-input-bg)",
                borderColor: savedDests.some(
                  (d) =>
                    Math.abs(d.lat - destLoc.lat) < 0.0001 &&
                    Math.abs(d.lng - destLoc.lng) < 0.0001
                )
                  ? "rgba(245,158,11,0.3)"
                  : "var(--panel-border)",
              }}
              title={
                savedDests.some(
                  (d) =>
                    Math.abs(d.lat - destLoc.lat) < 0.0001 &&
                    Math.abs(d.lng - destLoc.lng) < 0.0001
                )
                  ? "Saved"
                  : "Save destination"
              }
            >
              <Star
                className={`w-4 h-4 ${
                  savedDests.some(
                    (d) =>
                      Math.abs(d.lat - destLoc.lat) < 0.0001 &&
                      Math.abs(d.lng - destLoc.lng) < 0.0001
                  )
                    ? "text-amber-500 fill-amber-500"
                    : ""
                }`}
                style={
                  !savedDests.some(
                    (d) =>
                      Math.abs(d.lat - destLoc.lat) < 0.0001 &&
                      Math.abs(d.lng - destLoc.lng) < 0.0001
                  )
                    ? { color: "var(--panel-text-muted)" }
                    : {}
                }
              />
            </button>
          )}
        </div>
      </div>

      {activeDropdown === "origin" &&
        !originLoc &&
        (originSuggestions.length > 0 || originLoading) && (
          <div
            className="mx-4 mb-2 rounded-xl overflow-hidden shadow-lg max-h-[240px] overflow-y-auto"
            style={{
              background: "var(--panel-bg-secondary)",
              border: "1px solid var(--panel-border)",
            }}
          >
            {originLoading && originSuggestions.length === 0 && (
              <div className="px-4 py-3 flex items-center gap-3">
                <Loader2
                  className="w-4 h-4 animate-spin"
                  style={{ color: "var(--panel-text-muted)" }}
                />
                <span className="text-xs" style={{ color: "var(--panel-text-muted)" }}>
                  Searching...
                </span>
              </div>
            )}
            {originSuggestions.map((s, i) =>
              renderSuggestion(s, i, () => {
                setOriginLoc(s);
                setOriginQuery(s.display_name.split(",")[0]);
                setOriginSuggestions([]);
                setActiveDropdown(null);
                onFlyTo(s.lat, s.lng);
                onPreviewPins?.(s, destLoc);
              })
            )}
          </div>
        )}

      {activeDropdown === "dest" &&
        !destLoc &&
        (destSuggestions.length > 0 || destLoading) && (
          <div
            className="mx-4 mb-2 rounded-xl overflow-hidden shadow-lg max-h-[240px] overflow-y-auto"
            style={{
              background: "var(--panel-bg-secondary)",
              border: "1px solid var(--panel-border)",
            }}
          >
            {destLoading && destSuggestions.length === 0 && (
              <div className="px-4 py-3 flex items-center gap-3">
                <Loader2
                  className="w-4 h-4 animate-spin"
                  style={{ color: "var(--panel-text-muted)" }}
                />
                <span className="text-xs" style={{ color: "var(--panel-text-muted)" }}>
                  Searching...
                </span>
              </div>
            )}
            {destSuggestions.map((s, i) =>
              renderSuggestion(s, i, () => {
                setDestLoc(s);
                setDestQuery(s.display_name.split(",")[0]);
                setDestSuggestions([]);
                setActiveDropdown(null);
                onFlyTo(s.lat, s.lng);
                onPreviewPins?.(originLoc, s);
              })
            )}
          </div>
        )}

      {activeStopIdx !== null &&
        stops[activeStopIdx] &&
        !stops[activeStopIdx].loc &&
        (stopSuggestions.length > 0 || stopLoading) && (
          <div
            className="mx-4 mb-2 rounded-xl overflow-hidden shadow-lg max-h-[240px] overflow-y-auto"
            style={{
              background: "var(--panel-bg-secondary)",
              border: "1px solid var(--panel-border)",
            }}
          >
            {stopLoading && stopSuggestions.length === 0 && (
              <div className="px-4 py-3 flex items-center gap-3">
                <Loader2
                  className="w-4 h-4 animate-spin"
                  style={{ color: "var(--panel-text-muted)" }}
                />
                <span className="text-xs" style={{ color: "var(--panel-text-muted)" }}>
                  Searching...
                </span>
              </div>
            )}
            {stopSuggestions.map((s, i) =>
              renderSuggestion(s, i, () => {
                const next = [...stops];
                next[activeStopIdx] = { query: s.display_name.split(",")[0], loc: s };
                setStops(next);
                setStopSuggestions([]);
                setActiveStopIdx(null);
                onFlyTo(s.lat, s.lng);
              })
            )}
          </div>
        )}

      <div className="flex-1" />
    </>
  );
}
