"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Navigation, Flame, Radio, Shield, TrendingUp, TrendingDown, MapPin, Minus } from "lucide-react";
import Sparkline from "@/components/charts/Sparkline";
import {
  getMultiStopRoute,
  buildAvoidZones,
  buildAvoidPolygons,
  isNearRoute,
  DEFAULT_AVOID_CATS,
  type TransportMode,
  type AvoidCategoryId,
} from "@/lib/routing";
import type { Incident } from "@/lib/api";
import type { RouteData } from "@/components/RoutePanel";
import type { WaypointPin } from "@/components/IncidentMap";
import SearchInput from "@/components/SearchInput";
import SavedPlaces from "@/components/SavedPlaces";
import DirectionsPanel from "@/components/DirectionsPanel";
import TripHUD from "@/components/TripHUD";
import IncidentFeed from "@/components/IncidentFeed";
import { getCurrentCity } from "@/lib/pulse-cities";

const ORS_API_KEY =
  process.env.NEXT_PUBLIC_ORS_KEY || "5b3ce3597851110001cf6248a1b2c3d4e5f6a7b8";

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

type View = "search" | "directions" | "trip";

interface StopLoc {
  display_name: string;
  lat: number;
  lng: number;
}

interface HotNeighborhood {
  name: string;
  slug: string;
  count: number;
}

interface CategoryBreakdownItem {
  label: string;
  color: string;
  cats: readonly string[];
  count: number;
}

interface Props {
  incidents: Incident[];
  onFlyTo: (lat: number, lng: number) => void;
  onRoutesChange: (routes: RouteData | null) => void;
  onUserLocation?: (lat: number, lng: number) => void;
  onTripActive?: (active: boolean, routeGeometry?: [number, number][], mode?: TransportMode) => void;
  onPreviewPins?: (origin: { lat: number; lng: number } | null, dest: { lat: number; lng: number } | null) => void;
  onPreviewWaypoints?: (waypoints: WaypointPin[] | null) => void;
  onSelectIncident?: (id: string) => void;
  selectedId?: string | null;
  tripProgress?: number;
  onGpsStatusChange?: (status: "idle" | "loading" | "found" | "denied") => void;
  timeFilterLabel?: string;
  trendPct?: number;
  hotNeighborhoods?: HotNeighborhood[];
  categoryBreakdown?: CategoryBreakdownItem[];
  hourlyData?: number[];
  onToggleCat?: (cats: readonly string[]) => void;
}

export default function SearchSidebar({
  incidents,
  onFlyTo,
  onRoutesChange,
  onUserLocation,
  onTripActive,
  onPreviewPins,
  onPreviewWaypoints,
  onSelectIncident,
  selectedId,
  tripProgress = 0,
  onGpsStatusChange,
  timeFilterLabel,
  trendPct = 0,
  hotNeighborhoods = [],
  categoryBreakdown = [],
  hourlyData = [],
  onToggleCat,
}: Props) {
  const [view, setView] = useState<View>("search");
  const [originQuery, setOriginQuery] = useState("");
  const [destQuery, setDestQuery] = useState("");
  const [originLoc, setOriginLoc] = useState<StopLoc | null>(null);
  const [destLoc, setDestLoc] = useState<StopLoc | null>(null);
  const [stops, setStops] = useState<{ query: string; loc: StopLoc | null }[]>([]);
  const [activeMode, setActiveMode] = useState<TransportMode>("driving-car");
  const [routeInfo, setRouteInfo] = useState<{
    isSafe: boolean;
    distanceKm: number;
    durationMin: number;
    nearbyCount: number;
  } | null>(null);
  const [avoidCats, setAvoidCats] = useState<Set<AvoidCategoryId>>(new Set(DEFAULT_AVOID_CATS));
  const avoidCatsRef = useRef(avoidCats);
  avoidCatsRef.current = avoidCats;
  const [rerouteAlert, setRerouteAlert] = useState<string | null>(null);
  const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<"idle" | "loading" | "found" | "denied">("idle");
  const destLocRef = useRef(destLoc);
  destLocRef.current = destLoc;
  const onUserLocationRef = useRef(onUserLocation);
  onUserLocationRef.current = onUserLocation;
  const onPreviewPinsRef = useRef(onPreviewPins);
  onPreviewPinsRef.current = onPreviewPins;
  const lastGpsEmitRef = useRef<{ t: number; lat: number; lng: number } | null>(null);
  const seededOriginQueryRef = useRef(false);
  const onGpsStatusChangeRef = useRef(onGpsStatusChange);
  onGpsStatusChangeRef.current = onGpsStatusChange;
  const incidentsRef = useRef(incidents);
  incidentsRef.current = incidents;

  useEffect(() => {
    onGpsStatusChangeRef.current?.(gpsStatus);
  }, [gpsStatus]);

  useEffect(() => {
    const cityCenter = () => {
      const c = getCurrentCity();
      return {
        lat: c.lat,
        lng: c.lng,
        label: `${c.name} (center)`,
      };
    };

    if (!navigator.geolocation) {
      setGpsStatus("denied");
      const fb = cityCenter();
      setOriginLoc({ display_name: fb.label, lat: fb.lat, lng: fb.lng });
      setOriginQuery(fb.label);
      onPreviewPinsRef.current?.({ lat: fb.lat, lng: fb.lng }, null);
      onUserLocationRef.current?.(fb.lat, fb.lng);
      return;
    }
    setGpsStatus("loading");

    const emit = (loc: { lat: number; lng: number }) => {
      const now = Date.now();
      const prev = lastGpsEmitRef.current;
      const movedM = prev ? haversineM(prev.lat, prev.lng, loc.lat, loc.lng) : Infinity;
      if (prev && now - prev.t < 900 && movedM < 10) return;
      lastGpsEmitRef.current = { t: now, ...loc };
      setUserPos(loc);
      setGpsStatus("found");
      setOriginLoc((prevLoc) => {
        if (prevLoc === null) {
          if (!seededOriginQueryRef.current) {
            seededOriginQueryRef.current = true;
            setOriginQuery("Your location");
          }
          return { display_name: "Your location", ...loc };
        }
        if (prevLoc.display_name === "Your location") return { ...prevLoc, ...loc };
        return prevLoc;
      });
      onUserLocationRef.current?.(loc.lat, loc.lng);
      const d = destLocRef.current;
      onPreviewPinsRef.current?.(loc, d ? { lat: d.lat, lng: d.lng } : null);
    };

    const watchId = navigator.geolocation.watchPosition(
      (pos) => emit({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {
        navigator.geolocation.clearWatch(watchId);
        setGpsStatus("denied");
        const fb = cityCenter();
        setOriginLoc({ display_name: fb.label, lat: fb.lat, lng: fb.lng });
        setOriginQuery(fb.label);
        onPreviewPinsRef.current?.({ lat: fb.lat, lng: fb.lng }, null);
        onUserLocationRef.current?.(fb.lat, fb.lng);
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const openDirections = useCallback(
    (destName?: string, destCoords?: { lat: number; lng: number }) => {
      setView("directions");
      if (destName && destCoords) {
        setDestQuery(destName);
        setDestLoc({ display_name: destName, ...destCoords });
        onPreviewPins?.(originLoc, destCoords);
      }
    },
    [originLoc, onPreviewPins]
  );

  const startTrip = useCallback(async () => {
    if (!originLoc || !destLoc) return;
    const waypoints: [number, number][] = [
      [originLoc.lat, originLoc.lng],
      ...stops.filter((s) => s.loc).map((s) => [s.loc!.lat, s.loc!.lng] as [number, number]),
      [destLoc.lat, destLoc.lng],
    ];
    const incSnap = incidentsRef.current;

    const directRoute = await getMultiStopRoute(ORS_API_KEY, activeMode, waypoints);
    if (!directRoute) return;

    const zones = buildAvoidZones(incSnap, avoidCatsRef.current);
    let routeData: RouteData;
    let meta: { distanceKm: number; durationMin: number; isSafe: boolean; nearbyCount: number };

    if (zones.length === 0) {
      routeData = { normal: directRoute, safe: null, avoidZones: [] };
      meta = { distanceKm: directRoute.distanceKm, durationMin: directRoute.durationMin, isSafe: false, nearbyCount: 0 };
    } else {
      const safeRoute = await getMultiStopRoute(ORS_API_KEY, activeMode, waypoints, buildAvoidPolygons(zones));
      const best = safeRoute || directRoute;
      routeData = { normal: directRoute, safe: safeRoute, avoidZones: zones };
      meta = { distanceKm: best.distanceKm, durationMin: best.durationMin, isSafe: !!safeRoute, nearbyCount: zones.length };
    }

    onRoutesChange(routeData);
    setRouteInfo({
      isSafe: meta.isSafe,
      distanceKm: meta.distanceKm,
      durationMin: meta.durationMin,
      nearbyCount: meta.nearbyCount,
    });
    setRerouteAlert(null);
    setView("trip");
    const geom = (routeData.safe || routeData.normal)?.geometry;
    activeRouteRef.current = geom ?? null;
    knownIncIdsRef.current = new Set(incidents.map((i) => i.id));
    onTripActive?.(true, geom, activeMode);
  }, [originLoc, destLoc, stops, activeMode, onRoutesChange, onTripActive, incidents]);

  // Auto-reroute: watch for new incidents near the active route geometry
  const activeRouteRef = useRef<[number, number][] | null>(null);
  const knownIncIdsRef = useRef<Set<string>>(new Set());
  const rerouteInFlightRef = useRef(false);

  useEffect(() => {
    const route = activeRouteRef.current;
    if (view !== "trip" || !route || route.length < 2 || rerouteInFlightRef.current) return;

    const newNearby = incidents.filter(
      (inc) =>
        inc.lat != null &&
        inc.lng != null &&
        !knownIncIdsRef.current.has(inc.id) &&
        (inc.w_eff ?? 0) > 0.25 &&
        isNearRoute(inc.lat!, inc.lng!, route, 0.5)
    );

    if (newNearby.length === 0) return;

    for (const inc of newNearby) knownIncIdsRef.current.add(inc.id);

    if (!originLoc || !destLoc) return;
    rerouteInFlightRef.current = true;
    setRerouteAlert(`New incident detected nearby — rerouting...`);

    const waypoints: [number, number][] = [
      [originLoc.lat, originLoc.lng],
      ...stops.filter((s) => s.loc).map((s) => [s.loc!.lat, s.loc!.lng] as [number, number]),
      [destLoc.lat, destLoc.lng],
    ];

    (async () => {
      try {
        const zones = buildAvoidZones(incidents, avoidCatsRef.current);
        const directRoute = await getMultiStopRoute(ORS_API_KEY, activeMode, waypoints);
        if (!directRoute) return;
        const safeRoute = zones.length > 0
          ? await getMultiStopRoute(ORS_API_KEY, activeMode, waypoints, buildAvoidPolygons(zones))
          : null;
        const best = safeRoute || directRoute;
        const routeData: RouteData = { normal: directRoute, safe: safeRoute, avoidZones: zones };
        onRoutesChange(routeData);
        setRouteInfo({
          isSafe: !!safeRoute,
          distanceKm: best.distanceKm,
          durationMin: best.durationMin,
          nearbyCount: zones.length,
        });
        const geom = best.geometry;
        activeRouteRef.current = geom;
        onTripActive?.(true, geom, activeMode);
        setRerouteAlert(`Route updated — avoiding ${newNearby.length} new incident${newNearby.length > 1 ? "s" : ""}`);
        setTimeout(() => setRerouteAlert(null), 5000);
      } catch {
        setRerouteAlert(null);
      } finally {
        rerouteInFlightRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidents, view]);

  const resetTrip = useCallback(() => {
    setRouteInfo(null);
    setDestLoc(null);
    setDestQuery("");
    setStops([]);
    setView("search");
    onRoutesChange(null);
    onTripActive?.(false);
    onPreviewPins?.(originLoc, null);
    onPreviewWaypoints?.(null);
    activeRouteRef.current = null;
  }, [onRoutesChange, onTripActive, onPreviewPins, onPreviewWaypoints, originLoc]);

  const highCount = incidents.filter((i) => i.s_base >= 0.7).length;

  return (
    <div className="absolute top-0 left-0 bottom-0 z-[1000] flex pointer-events-none">
      <div
        className="w-[380px] h-full flex flex-col pointer-events-auto backdrop-blur-xl shadow-2xl
                   max-md:fixed max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:top-auto max-md:w-full max-md:h-[55vh] max-md:z-[2000] max-md:rounded-t-2xl"
        style={{
          background: "var(--panel-bg)",
          borderRight: "1px solid var(--panel-border)",
          boxShadow: "4px 0 24px var(--panel-shadow)",
        }}
      >
        {/* Mobile drag handle */}
        <div className="md:hidden flex justify-center pt-2 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full" style={{ background: "var(--panel-text-muted)", opacity: 0.4 }} />
        </div>
        {view === "search" && (
          <>
            <SearchInput onFlyTo={onFlyTo} onDirections={openDirections} />

            <button
              onClick={() => openDirections()}
              className="mx-4 mb-2 w-[calc(100%-2rem)] flex items-center gap-3 px-4 py-2.5 rounded-xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 transition-all text-sm text-blue-500 font-medium"
            >
              <Navigation className="w-4 h-4" />
              Get Safe Directions
            </button>

            <SavedPlaces onFlyTo={onFlyTo} onDirections={openDirections} />

            {/* Stats strip */}
            <div
              className="px-4 py-3 space-y-3"
              style={{ borderBottom: "1px solid var(--panel-border)" }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-[11px] text-green-500 font-medium">LIVE</span>
                  <span className="text-[11px]" style={{ color: "var(--panel-text-muted)" }}>·</span>
                  <span className="text-[11px] font-semibold" style={{ color: "var(--panel-text)" }}>
                    {incidents.length}
                  </span>
                  <span className="text-[11px]" style={{ color: "var(--panel-text-secondary)" }}>
                    incidents
                  </span>
                </div>
                {trendPct !== 0 && (
                  <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                    trendPct > 0 ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"
                  }`}>
                    {trendPct > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {trendPct > 0 ? "+" : ""}{trendPct}%
                  </div>
                )}
                {trendPct === 0 && (
                  <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
                    style={{ background: "var(--panel-input-bg)", color: "var(--panel-text-muted)" }}>
                    <Minus className="w-3 h-3" />
                    0%
                  </div>
                )}
              </div>
              {highCount > 0 && (
                <div className="flex items-center gap-1.5">
                  <Flame className="w-3 h-3 text-amber-500" />
                  <span className="text-[10px] text-amber-500 font-medium">{highCount} critical</span>
                </div>
              )}

              {/* Today's hourly sparkline */}
              {hourlyData.length > 0 && hourlyData.some((v) => v > 0) && (
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-wider mb-1" style={{ color: "var(--panel-text-muted)" }}>
                    Today&apos;s Activity
                  </p>
                  <Sparkline data={hourlyData} color="#3b82f6" width={340} height={28} filled />
                  <div className="flex justify-between mt-0.5">
                    <span className="text-[8px]" style={{ color: "var(--panel-text-muted)" }}>12am</span>
                    <span className="text-[8px]" style={{ color: "var(--panel-text-muted)" }}>6am</span>
                    <span className="text-[8px]" style={{ color: "var(--panel-text-muted)" }}>12pm</span>
                    <span className="text-[8px]" style={{ color: "var(--panel-text-muted)" }}>6pm</span>
                    <span className="text-[8px]" style={{ color: "var(--panel-text-muted)" }}>12am</span>
                  </div>
                </div>
              )}

              {/* Category breakdown bar */}
              {categoryBreakdown.length > 0 && (
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--panel-text-muted)" }}>
                    By Category
                  </p>
                  <div className="flex h-2 rounded-full overflow-hidden gap-px">
                    {categoryBreakdown.map((cat) => (
                      <div
                        key={cat.label}
                        className="h-full cursor-pointer transition-opacity hover:opacity-80"
                        style={{
                          backgroundColor: cat.color,
                          flexGrow: cat.count,
                        }}
                        title={`${cat.label}: ${cat.count}`}
                        onClick={() => onToggleCat?.(cat.cats)}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
                    {categoryBreakdown.map((cat) => (
                      <button
                        key={cat.label}
                        className="flex items-center gap-1 text-[9px] transition-opacity hover:opacity-80"
                        style={{ color: "var(--panel-text-secondary)" }}
                        onClick={() => onToggleCat?.(cat.cats)}
                      >
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                        {cat.label}
                        <span className="font-mono" style={{ color: "var(--panel-text-muted)" }}>{cat.count}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Hot neighborhoods */}
              {hotNeighborhoods.length > 0 && (
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--panel-text-muted)" }}>
                    Hot Spots
                  </p>
                  <div className="space-y-1">
                    {hotNeighborhoods.map((n, idx) => (
                      <div key={n.slug} className="flex items-center gap-2">
                        <span className="text-[9px] font-mono w-3 text-right" style={{ color: "var(--panel-text-muted)" }}>{idx + 1}</span>
                        <MapPin className="w-3 h-3 shrink-0" style={{ color: idx === 0 ? "#ef4444" : idx < 3 ? "#f59e0b" : "var(--panel-text-muted)" }} />
                        <span className="text-[10px] flex-1 truncate" style={{ color: "var(--panel-text-secondary)" }}>{n.name}</span>
                        <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--panel-input-bg)" }}>
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.min(100, (n.count / (hotNeighborhoods[0]?.count || 1)) * 100)}%`,
                              backgroundColor: idx === 0 ? "#ef4444" : idx < 3 ? "#f59e0b" : "#3b82f6",
                            }}
                          />
                        </div>
                        <span className="text-[9px] font-mono w-4 text-right" style={{ color: "var(--panel-text-muted)" }}>{n.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              <div className="px-4 py-2">
                <h3
                  className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  <Radio className="w-3 h-3" /> {timeFilterLabel ? `Incidents — ${timeFilterLabel}` : "Recent Incidents"}
                </h3>
              </div>
              <IncidentFeed
                incidents={incidents}
                selectedId={selectedId ?? null}
                onSelect={(id) => {
                  onSelectIncident?.(id);
                  const inc = incidents.find((i) => i.id === id);
                  if (inc?.lat && inc?.lng) onFlyTo(inc.lat, inc.lng);
                }}
              />
            </div>

            <div
              className="px-4 py-3 flex items-center gap-2"
              style={{ borderTop: "1px solid var(--panel-border)" }}
            >
              <Shield className="w-4 h-4 text-blue-500/60" />
              <span className="text-[11px]" style={{ color: "var(--panel-text-muted)" }}>
                CityPulse · AI-Powered Community Safety
              </span>
            </div>
          </>
        )}

        {view === "directions" && (
          <DirectionsPanel
            incidents={incidents}
            originLoc={originLoc}
            setOriginLoc={setOriginLoc}
            originQuery={originQuery}
            setOriginQuery={setOriginQuery}
            destLoc={destLoc}
            setDestLoc={setDestLoc}
            destQuery={destQuery}
            setDestQuery={setDestQuery}
            stops={stops}
            setStops={setStops}
            activeMode={activeMode}
            setActiveMode={setActiveMode}
            userPos={userPos}
            gpsStatus={gpsStatus}
            onBack={() => {
              setView("search");
              setDestLoc(null);
              setDestQuery("");
              setStops([]);
              onRoutesChange(null);
              onPreviewPins?.(originLoc, null);
              onPreviewWaypoints?.(null);
            }}
            onFlyTo={onFlyTo}
            onRoutesChange={onRoutesChange}
            onPreviewPins={onPreviewPins}
            onPreviewWaypoints={onPreviewWaypoints}
            onStartTrip={startTrip}
            avoidCats={avoidCats}
            onAvoidCatsChange={setAvoidCats}
          />
        )}

        {view === "trip" && rerouteAlert && (
          <div
            className="mx-3 mt-2 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium animate-pulse"
            style={{
              background: "rgba(245,158,11,0.12)",
              border: "1px solid rgba(245,158,11,0.25)",
              color: "#f59e0b",
            }}
          >
            <Navigation className="w-3.5 h-3.5 shrink-0" />
            {rerouteAlert}
          </div>
        )}

        {view === "trip" && routeInfo && (
          <TripHUD
            routeInfo={routeInfo}
            originQuery={originQuery}
            destQuery={destQuery}
            stops={stops}
            activeMode={activeMode}
            tripProgress={tripProgress}
            onResetTrip={resetTrip}
            recentIncidents={incidents.slice(0, 12)}
            onSelectIncident={(id) => onSelectIncident?.(id)}
            onFlyTo={onFlyTo}
          />
        )}
      </div>
    </div>
  );
}
