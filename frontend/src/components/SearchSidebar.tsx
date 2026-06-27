"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Navigation,
  Flame,
  Radio,
  Shield,
  TrendingUp,
  TrendingDown,
  MapPin,
  Minus,
  Menu,
  X,
  Bookmark,
  History,
  Bell,
  Settings,
  Share2,
  Printer,
  CircleHelp,
  Layers,
  Sparkles,
  Database,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import Sparkline from "@/components/charts/Sparkline";
import {
  getMultiStopRoute,
  buildAvoidZones,
  buildAvoidPolygons,
  isNearRoute,
  distanceAlongRoute,
  defaultAvoidancePrefs,
  SAFEST_ROUTE_ONLY_UI,
  type TransportMode,
  type AvoidancePrefs,
  type SeverityFloor,
  type ManeuverStep,
} from "@/lib/routing";
import type { Incident } from "@/lib/api";
import { userAvoidZonesForRouting } from "@/lib/avoid-areas";
import type { RouteData } from "@/components/RoutePanel";
import type { WaypointPin } from "@/components/IncidentMap";
import SearchInput from "@/components/SearchInput";
import SavedPlaces from "@/components/SavedPlaces";
import NearbyChips from "@/components/NearbyChips";
import TripHistory from "@/components/TripHistory";
import SearchedPlaceCard, { type SelectedPlace } from "@/components/SearchedPlaceCard";
import DirectionsPanel from "@/components/DirectionsPanel";
import TripHUD from "@/components/TripHUD";
import IncidentFeed from "@/components/IncidentFeed";
import MobileSheet from "@/components/MobileSheet";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getCurrentCity } from "@/lib/pulse-cities";
import { buildTripShareUrl } from "@/lib/share-trip";
import { saveTripSnapshot, clearTripSnapshot, updateTripProgress } from "@/lib/trip-resume";
import { share as nativeShare } from "@/lib/native";
import { setPref } from "@/lib/prefs-sync";
import { useAuth } from "@/contexts/AuthContext";
import { publishRouteState } from "@/lib/route-state";
import { openAskPulseTab } from "@/lib/open-ask-pulse";
import { speakNav } from "@/lib/voice-nav";

const ORS_API_KEY =
  process.env.NEXT_PUBLIC_ORS_KEY || "5b3ce3597851110001cf6248a1b2c3d4e5f6a7b8";

const MAP_SIDEBAR_WIDTH_LS = "pp:map-sidebar-width";
const MAP_SIDEBAR_DEFAULT = 380;
const MAP_SIDEBAR_MIN = 280;
const MAP_SIDEBAR_MAX = 560;
const MAP_RAIL_WIDTH = 72;

function readSavedSidebarWidth(): number {
  if (typeof window === "undefined") return MAP_SIDEBAR_DEFAULT;
  try {
    const raw = window.localStorage.getItem(MAP_SIDEBAR_WIDTH_LS);
    if (raw == null) return MAP_SIDEBAR_DEFAULT;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return MAP_SIDEBAR_DEFAULT;
    return Math.min(MAP_SIDEBAR_MAX, Math.max(MAP_SIDEBAR_MIN, n));
  } catch {
    return MAP_SIDEBAR_DEFAULT;
  }
}

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
type DesktopPanel = "menu" | "feed" | "saved" | "recents" | "directions" | null;

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
  onTripActive?: (
    active: boolean,
    routeGeometry?: [number, number][],
    mode?: TransportMode,
    steps?: ManeuverStep[],
    meta?: {
      distanceKm: number;
      durationMin: number;
      nearbyCount: number;
      isSafe: boolean;
      origin?: { display_name: string; lat: number; lng: number };
      dest?: { display_name: string; lat: number; lng: number };
    }
  ) => void;
  onPreviewPins?: (origin: { lat: number; lng: number } | null, dest: { lat: number; lng: number } | null) => void;
  onPreviewWaypoints?: (waypoints: WaypointPin[] | null) => void;
  /** Fired when the searched-place pin should appear or disappear on
   *  the map. Parent forwards the coords to IncidentMap so it can
   *  drop a Google-Maps-style red lollipop at the tapped place and
   *  fly the map to it. Null clears the pin. */
  onSearchedPlaceChange?: (place: { lat: number; lng: number; name: string } | null) => void;
  onSelectIncident?: (id: string) => void;
  selectedId?: string | null;
  tripProgress?: number;
  onGpsStatusChange?: (status: "idle" | "loading" | "found" | "denied") => void;
  timeFilterLabel?: string;
  timeFilterHours?: number;
  trendPct?: number;
  hotNeighborhoods?: HotNeighborhood[];
  categoryBreakdown?: CategoryBreakdownItem[];
  hourlyData?: number[];
  onToggleCat?: (cats: readonly string[]) => void;
  /** Mobile-only: controls whether the bottom sheet is mounted/visible. */
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
}

export default function SearchSidebar({
  incidents,
  onFlyTo,
  onRoutesChange,
  onUserLocation,
  onTripActive,
  onPreviewPins,
  onPreviewWaypoints,
  onSearchedPlaceChange,
  onSelectIncident,
  selectedId,
  tripProgress = 0,
  onGpsStatusChange,
  timeFilterLabel,
  timeFilterHours,
  trendPct = 0,
  hotNeighborhoods = [],
  categoryBreakdown = [],
  hourlyData = [],
  onToggleCat,
  mobileOpen = true,
  onMobileOpenChange,
}: Props) {
  const isMobile = useIsMobile();
  const [sidebarWidthPx, setSidebarWidthPx] = useState(readSavedSidebarWidth);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeDesktopPanel, setActiveDesktopPanel] = useState<DesktopPanel>(null);
  const [view, setView] = useState<View>("search");
  /** Set when the user taps a search-result row. Shows the
   *  Directions/Save/Share card in place of the default search shelf
   *  (saved places, trip history, etc.) until dismissed. */
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(null);
  const { user } = useAuth();
  const desktopPanelVisible = !isMobile && (drawerOpen || activeDesktopPanel !== null || view === "directions" || view === "trip");
  const desktopOccupiedWidth = desktopPanelVisible ? MAP_RAIL_WIDTH + sidebarWidthPx : MAP_RAIL_WIDTH;

  useEffect(() => {
    if (isMobile) {
      document.documentElement.style.removeProperty("--pp-map-sidebar-width");
      return;
    }
    document.documentElement.style.setProperty("--pp-map-sidebar-width", `${desktopOccupiedWidth}px`);
    return () => {
      document.documentElement.style.removeProperty("--pp-map-sidebar-width");
    };
  }, [desktopOccupiedWidth, isMobile]);

  const onSidebarResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isMobile) return;
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = sidebarWidthPx;
      let currentW = startW;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const move = (ev: PointerEvent) => {
        const dw = ev.clientX - startX;
        currentW = Math.min(MAP_SIDEBAR_MAX, Math.max(MAP_SIDEBAR_MIN, startW + dw));
        setSidebarWidthPx(currentW);
      };
      const cleanup = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        try {
          window.localStorage.setItem(MAP_SIDEBAR_WIDTH_LS, String(currentW));
        } catch {
          /* ignore */
        }
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [isMobile, sidebarWidthPx]
  );
  // Display name (if signed in) is included on share-ETA links so the
  // recipient sees "Eli is driving" rather than "Someone is driving".
  // Held in a ref so the share callback always sees the current value
  // without re-creating itself.
  const senderDisplayName = useRef<string>("");
  useEffect(() => {
    senderDisplayName.current = user?.displayName?.trim() || "";
  }, [user?.displayName]);
  const [originQuery, setOriginQuery] = useState("");
  const [destQuery, setDestQuery] = useState("");
  const [originLoc, setOriginLoc] = useState<StopLoc | null>(null);
  const [destLoc, setDestLoc] = useState<StopLoc | null>(null);
  // `id` is a synthetic stable key used by the drag-to-reorder list in
  // DirectionsPanel — we can't key on array index there because reorder
  // would unmount + remount every input on each move.
  const [stops, setStops] = useState<{ id: string; query: string; loc: StopLoc | null }[]>([]);
  const [activeMode, setActiveMode] = useState<TransportMode>("driving-car");
  const [routeInfo, setRouteInfo] = useState<{
    isSafe: boolean;
    distanceKm: number;
    durationMin: number;
    nearbyCount: number;
  } | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  // Per-category avoidance + severity floor, persisted across reloads
  // so a user who turned off "shots fired" yesterday isn't surprised
  // when it comes back on. Read once on mount; serialised on every change.
  const [avoidPrefs, setAvoidPrefsState] = useState<AvoidancePrefs>(() => {
    if (typeof window === "undefined") return defaultAvoidancePrefs();
    try {
      const raw = window.localStorage.getItem("pp:avoid-prefs-v2");
      if (!raw) return defaultAvoidancePrefs();
      const parsed = JSON.parse(raw) as { leaves?: string[]; minSeverity?: SeverityFloor };
      return {
        leaves: new Set(Array.isArray(parsed.leaves) ? parsed.leaves : []),
        minSeverity:
          parsed.minSeverity === "any" || parsed.minSeverity === "low" ||
          parsed.minSeverity === "medium" || parsed.minSeverity === "high"
            ? parsed.minSeverity
            : "low",
      };
    } catch {
      return defaultAvoidancePrefs();
    }
  });
  const setAvoidPrefs = useCallback((next: AvoidancePrefs) => {
    setAvoidPrefsState(next);
    if (typeof window !== "undefined") {
      try {
        // Route through prefs-sync so the avoidance config follows
        // the user across devices when signed in.
        setPref(
          "pp:avoid-prefs-v2",
          JSON.stringify({ leaves: Array.from(next.leaves), minSeverity: next.minSeverity })
        );
      } catch { /* storage full / blocked — non-fatal */ }
    }
  }, []);
  const avoidPrefsRef = useRef(avoidPrefs);
  avoidPrefsRef.current = avoidPrefs;

  // Latest RouteData reported by the directions picker. Used by
  // `startTrip` so the option the user picked (e.g. "No tolls" /
  // "Safer") becomes the active trip rather than always defaulting to
  // safe ?? normal.
  const latestRouteDataRef = useRef<{ data: RouteData; mode: TransportMode } | null>(null);
  const handleRoutesChange = useCallback(
    (data: RouteData | null) => {
      latestRouteDataRef.current = data ? { data, mode: activeMode } : null;
      onRoutesChange(data);
    },
    [activeMode, onRoutesChange]
  );
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
      setUserPos(null);
      const fb = cityCenter();
      setOriginLoc({ display_name: fb.label, lat: fb.lat, lng: fb.lng });
      setOriginQuery(fb.label);
      onPreviewPinsRef.current?.({ lat: fb.lat, lng: fb.lng }, null);
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
        setUserPos(null);
        const fb = cityCenter();
        setOriginLoc({ display_name: fb.label, lat: fb.lat, lng: fb.lng });
        setOriginQuery(fb.label);
        onPreviewPinsRef.current?.({ lat: fb.lat, lng: fb.lng }, null);
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const openDirections = useCallback(
    (destName?: string, destCoords?: { lat: number; lng: number }) => {
      setSelectedPlace(null);
      setView("directions");
      setDrawerOpen(true);
      setActiveDesktopPanel("directions");
      if (destName && destCoords) {
        setDestQuery(destName);
        setDestLoc({ display_name: destName, ...destCoords });
        onPreviewPins?.(originLoc, destCoords);
      }
    },
    [originLoc, onPreviewPins]
  );

  const clearSelectedPlacePreview = useCallback(() => {
    setSelectedPlace(null);
    setDestQuery("");
    setDestLoc(null);
    setStops([]);
    handleRoutesChange(null);
    onPreviewWaypoints?.(null);
    onPreviewPins?.(originLoc, null);
  }, [handleRoutesChange, onPreviewPins, onPreviewWaypoints, originLoc]);

  const handlePlaceSelected = useCallback(
    (place: SelectedPlace) => {
      const coords = { lat: place.lat, lng: place.lng };
      setSelectedPlace(place);
      setDestQuery(place.name);
      setDestLoc({ display_name: place.name, ...coords });
      setStops([]);
      setView("search");
      setDrawerOpen(true);
      setActiveDesktopPanel(null);
      handleRoutesChange(null);
      onPreviewWaypoints?.(null);
      // Clear any leftover routing A/B preview pins from a prior
      // directions session — IncidentMap will instead drop the
      // dedicated red place pin via onSearchedPlaceChange below.
      onPreviewPins?.(null, null);
    },
    [handleRoutesChange, onPreviewPins, onPreviewWaypoints]
  );

  const openSelectedPlaceDirections = useCallback(
    (place: SelectedPlace) => {
      setSelectedPlace(null);
      openDirections(place.name, { lat: place.lat, lng: place.lng });
    },
    [openDirections]
  );

  /** One-tap "Start" from the place card. Seeds the destination, flips
   *  to the directions view so the trip HUD has a panel to mount into,
   *  and arms `pendingResumeRef` so the existing
   *  flush-then-startTrip effect kicks off live navigation as soon as
   *  React commits the new destLoc. Mirrors Google Maps' Start button
   *  which jumps the user straight into nav without a routing detour. */
  const startTripFromPlace = useCallback(
    (place: SelectedPlace) => {
      setSelectedPlace(null);
      setDestQuery(place.name);
      setDestLoc({ display_name: place.name, lat: place.lat, lng: place.lng });
      setStops([]);
      setActiveMode("driving-car");
      setView("directions");
      setDrawerOpen(true);
      setActiveDesktopPanel("directions");
      onPreviewPins?.(originLoc, { lat: place.lat, lng: place.lng });
      pendingResumeRef.current = true;
    },
    [onPreviewPins, originLoc]
  );

  const requestNavigationLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsStatus("denied");
      setUserPos(null);
      return Promise.resolve<StopLoc | null>(null);
    }

    setGpsStatus("loading");
    return new Promise<StopLoc | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = {
            display_name: "Your location",
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          };
          setUserPos({ lat: loc.lat, lng: loc.lng });
          setGpsStatus("found");
          onUserLocationRef.current?.(loc.lat, loc.lng);
          resolve(loc);
        },
        () => {
          setGpsStatus("denied");
          setUserPos(null);
          resolve(null);
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
      );
    });
  }, []);

  /** Listen for cross-component "plan a route to/from this place" events
   *  dispatched by PlaceActions buttons inside cards. mode:"to" pre-fills
   *  the destination; mode:"from" pre-fills the origin. */
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{
        mode: "to" | "from";
        lat: number;
        lng: number;
        label: string;
        /** Optional ORS transport profile. When present, switches the
         *  active mode before computing the route — used by the
         *  Get-to-safety panel to force "Walk" vs "Drive" rather than
         *  inheriting whatever the user last selected. */
        transport?: TransportMode;
      }>).detail;
      if (!detail) return;
      const { mode, lat, lng, label, transport } = detail;
      if (mode === "to") {
        setDestQuery(label);
        setDestLoc({ display_name: label, lat, lng });
        onPreviewPins?.(originLoc, { lat, lng });
      } else {
        setOriginQuery(label);
        setOriginLoc({ display_name: label, lat, lng });
        onPreviewPins?.({ lat, lng }, destLocRef.current ? { lat: destLocRef.current.lat, lng: destLocRef.current.lng } : null);
      }
      if (transport) setActiveMode(transport);
      setView("directions");
      setDrawerOpen(true);
      setActiveDesktopPanel("directions");
    }
    window.addEventListener("pp:plan-route", handler);
    return () => window.removeEventListener("pp:plan-route", handler);
  }, [originLoc, onPreviewPins]);

  // Tell the parent which place (if any) should get the dedicated
  // red lollipop pin on the map. The pin is only meaningful while the
  // place card itself is on-screen — once the user moves into
  // directions or an active trip, the route's A/B/STOP markers take
  // over and we clear the searched-place pin so it doesn't double up.
  useEffect(() => {
    const visible = view === "search" && selectedPlace !== null;
    onSearchedPlaceChange?.(
      visible
        ? { lat: selectedPlace.lat, lng: selectedPlace.lng, name: selectedPlace.name }
        : null
    );
  }, [view, selectedPlace, onSearchedPlaceChange]);

  /** Publish the current route-planning state so leaf components like
   *  PlaceActions can show context-aware controls (e.g. "Add as stop")
   *  without prop-drilling our internal view/origin/dest state down to
   *  every card. The pubsub diff-checks before notifying subscribers,
   *  so the cost of running this on every render is negligible. */
  useEffect(() => {
    publishRouteState({
      view,
      hasOrigin: originLoc !== null,
      hasDest: destLoc !== null,
      tripActive: view === "trip",
    });
  }, [view, originLoc, destLoc]);

  /** Listen for "add this POI as an intermediate stop" events fired by
   *  AlongRoutePanel. We append a new fully-resolved stop to the
   *  existing list so the route recomputation in DirectionsPanel can
   *  pick it up on its next debounced rerun. */
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ name: string; lat: number; lng: number }>).detail;
      if (!detail) return;
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setStops((prev) => [
        ...prev,
        {
          id,
          query: detail.name,
          loc: { display_name: detail.name, lat: detail.lat, lng: detail.lng },
        },
      ]);
      // Make sure the directions view is open so the user actually
      // sees their stop appear and can rearrange/remove it.
      setView("directions");
      setDrawerOpen(true);
      setActiveDesktopPanel("directions");
    }
    window.addEventListener("pp:add-stop", handler);
    return () => window.removeEventListener("pp:add-stop", handler);
  }, []);

  /** Resume-trip wiring. The pill in page.tsx fires this event after
   *  user confirmation; we hydrate origin/dest/stops/mode from the
   *  payload and signal startTrip via a ref-set flag (the actual
   *  startTrip call must wait for the state updates to flush). */
  const pendingResumeRef = useRef(false);
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{
        origin: { display_name: string; lat: number; lng: number };
        dest: { display_name: string; lat: number; lng: number };
        stops: { id: string; query: string; loc: { display_name: string; lat: number; lng: number } | null }[];
        mode: TransportMode;
      }>).detail;
      if (!detail) return;
      setOriginQuery(detail.origin.display_name);
      setOriginLoc(detail.origin);
      setDestQuery(detail.dest.display_name);
      setDestLoc(detail.dest);
      setStops(detail.stops);
      setActiveMode(detail.mode);
      setView("directions");
      setDrawerOpen(true);
      setActiveDesktopPanel("directions");
      pendingResumeRef.current = true;
    }
    window.addEventListener("pp:resume-trip", handler);
    return () => window.removeEventListener("pp:resume-trip", handler);
  }, []);

  // Once originLoc + destLoc have flushed from the resume hydration,
  // kick off startTrip() exactly once.
  useEffect(() => {
    if (!pendingResumeRef.current) return;
    if (!originLoc || !destLoc) return;
    pendingResumeRef.current = false;
    void startTrip();
    // startTrip is intentionally outside the deps — we only want this
    // useEffect to fire when the hydrated locs settle, not on every
    // re-render of startTrip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originLoc, destLoc]);

  const startTrip = useCallback(async () => {
    if (!originLoc || !destLoc) return;

    const gpsOrigin =
      gpsStatus === "found" && userPos
        ? { display_name: "Your location", lat: userPos.lat, lng: userPos.lng }
        : await requestNavigationLocation();

    if (!gpsOrigin) {
      throw new Error("Enable location to start live navigation.");
    }

    const navOriginLoc: StopLoc = gpsOrigin;
    setOriginLoc(navOriginLoc);
    setOriginQuery("Your location");
    onPreviewPins?.({ lat: navOriginLoc.lat, lng: navOriginLoc.lng }, { lat: destLoc.lat, lng: destLoc.lng });

    // If the picker has already produced a chosen route, prefer that —
    // it may be an alternate, "Safer", "No tolls", etc., and re-running
    // routing here would discard the user's selection.
    const picked = latestRouteDataRef.current;
    const pickedMatchesLiveOrigin = originLoc
      ? haversineM(originLoc.lat, originLoc.lng, navOriginLoc.lat, navOriginLoc.lng) < 25
      : false;
    let routeData: RouteData | null = null;
    let meta: { distanceKm: number; durationMin: number; isSafe: boolean; nearbyCount: number } | null = null;

    if (picked && picked.data.chosen && picked.mode === activeMode && pickedMatchesLiveOrigin) {
      routeData = picked.data;
      meta = {
        distanceKm: picked.data.chosen.distanceKm,
        durationMin: picked.data.chosen.durationMin,
        isSafe: picked.data.chosen.isSafe,
        nearbyCount: picked.data.avoidZones.length,
      };
    } else {
      const waypoints: [number, number][] = [
        [navOriginLoc.lat, navOriginLoc.lng],
        ...stops.filter((s) => s.loc).map((s) => [s.loc!.lat, s.loc!.lng] as [number, number]),
        [destLoc.lat, destLoc.lng],
      ];
      const incSnap = incidentsRef.current;

      const directRoute = await getMultiStopRoute(ORS_API_KEY, activeMode, waypoints);
      if (!directRoute) return;

      const incidentZones = buildAvoidZones(incSnap, avoidPrefsRef.current);
      // Personal "avoid this area" pins from the user's blocklist —
      // routed identically to incident-driven zones.
      const userZones = userAvoidZonesForRouting();
      const zones = [...incidentZones, ...userZones];
      if (zones.length === 0) {
        routeData = {
          normal: directRoute,
          safe: null,
          avoidZones: [],
          chosen: directRoute,
          chosenLabel: SAFEST_ROUTE_ONLY_UI ? "Route" : "Fastest",
        };
        meta = { distanceKm: directRoute.distanceKm, durationMin: directRoute.durationMin, isSafe: false, nearbyCount: 0 };
      } else {
        const safeRoute = await getMultiStopRoute(ORS_API_KEY, activeMode, waypoints, buildAvoidPolygons(zones));
        const best = safeRoute || directRoute;
        routeData = {
          normal: directRoute,
          safe: safeRoute,
          avoidZones: zones,
          chosen: best,
          chosenLabel: safeRoute ? "Safer" : SAFEST_ROUTE_ONLY_UI ? "Route" : "Fastest",
        };
        meta = { distanceKm: best.distanceKm, durationMin: best.durationMin, isSafe: !!safeRoute, nearbyCount: zones.length };
      }
    }

    if (!routeData || !meta) return;

    handleRoutesChange(routeData);
    setRouteInfo({
      isSafe: meta.isSafe,
      distanceKm: meta.distanceKm,
      durationMin: meta.durationMin,
      nearbyCount: meta.nearbyCount,
    });
    setRerouteAlert(null);
    setView("trip");
    if (isMobile) {
      onMobileOpenChange?.(false);
    } else {
      setDrawerOpen(true);
      setActiveDesktopPanel(null);
    }
    const active = routeData.chosen ?? routeData.safe ?? routeData.normal;
    const geom = active?.geometry;
    activeRouteRef.current = geom ?? null;
    knownIncIdsRef.current = new Set(incidents.map((i) => i.id));
    onTripActive?.(true, geom, activeMode, active?.steps, {
      distanceKm: meta.distanceKm,
      durationMin: meta.durationMin,
      nearbyCount: meta.nearbyCount,
      isSafe: meta.isSafe,
      origin: { display_name: navOriginLoc.display_name, lat: navOriginLoc.lat, lng: navOriginLoc.lng },
      dest: { display_name: destLoc.display_name, lat: destLoc.lat, lng: destLoc.lng },
    });

    // Persist trip inputs so a refresh / accidental tab close can offer
    // a "Resume trip?" pill on next mount. Geometry isn't stored — we
    // rerun startTrip() with the same waypoints to rebuild it.
    saveTripSnapshot({
      origin: { display_name: navOriginLoc.display_name, lat: navOriginLoc.lat, lng: navOriginLoc.lng },
      dest: { display_name: destLoc.display_name, lat: destLoc.lat, lng: destLoc.lng },
      stops: stops.map((s) => ({
        id: s.id,
        query: s.query,
        loc: s.loc ? { display_name: s.loc.display_name, lat: s.loc.lat, lng: s.loc.lng } : null,
      })),
      mode: activeMode,
      startedAt: Date.now(),
      progress: 0,
    });
  }, [
    originLoc,
    destLoc,
    stops,
    activeMode,
    handleRoutesChange,
    onTripActive,
    onPreviewPins,
    incidents,
    isMobile,
    onMobileOpenChange,
    gpsStatus,
    userPos,
    requestNavigationLocation,
  ]);

  // Auto-reroute: watch for new incidents near the active route geometry
  const activeRouteRef = useRef<[number, number][] | null>(null);
  const knownIncIdsRef = useRef<Set<string>>(new Set());
  const rerouteInFlightRef = useRef(false);
  const offRouteSinceRef = useRef<number | null>(null);
  const lastOffRouteRerouteRef = useRef(0);

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
    setRerouteAlert(`New incident detected nearby. Rerouting...`);

    const waypoints: [number, number][] = [
      [originLoc.lat, originLoc.lng],
      ...stops.filter((s) => s.loc).map((s) => [s.loc!.lat, s.loc!.lng] as [number, number]),
      [destLoc.lat, destLoc.lng],
    ];

    (async () => {
      try {
        const zones = [
          ...buildAvoidZones(incidents, avoidPrefsRef.current),
          ...userAvoidZonesForRouting(),
        ];
        const directRoute = await getMultiStopRoute(ORS_API_KEY, activeMode, waypoints);
        if (!directRoute) return;
        const safeRoute = zones.length > 0
          ? await getMultiStopRoute(ORS_API_KEY, activeMode, waypoints, buildAvoidPolygons(zones))
          : null;
        const best = safeRoute || directRoute;
        const routeData: RouteData = {
          normal: directRoute,
          safe: safeRoute,
          avoidZones: zones,
          chosen: best,
          chosenLabel: safeRoute ? "Safer" : SAFEST_ROUTE_ONLY_UI ? "Route" : "Fastest",
        };
        handleRoutesChange(routeData);
        setRouteInfo({
          isSafe: !!safeRoute,
          distanceKm: best.distanceKm,
          durationMin: best.durationMin,
          nearbyCount: zones.length,
        });
        const geom = best.geometry;
        activeRouteRef.current = geom;
        onTripActive?.(true, geom, activeMode, best.steps, {
          distanceKm: best.distanceKm,
          durationMin: best.durationMin,
          nearbyCount: zones.length,
          isSafe: !!safeRoute,
          // Origin/dest still resolved from the original trip — pass
          // through unchanged so the recap & history entry don't lose
          // the labels after a mid-trip reroute.
          origin: originLoc ? { display_name: originLoc.display_name, lat: originLoc.lat, lng: originLoc.lng } : undefined,
          dest: destLoc ? { display_name: destLoc.display_name, lat: destLoc.lat, lng: destLoc.lng } : undefined,
        });
        setRerouteAlert(`Route updated · avoiding ${newNearby.length} new incident${newNearby.length > 1 ? "s" : ""}`);
        setTimeout(() => setRerouteAlert(null), 5000);
      } catch {
        setRerouteAlert(null);
      } finally {
        rerouteInFlightRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidents, view]);

  // Auto-reroute when GPS says the driver has left the route. We require
  // a sustained offset so one noisy mobile location fix does not thrash
  // the trip line.
  useEffect(() => {
    const route = activeRouteRef.current;
    if (
      view !== "trip" ||
      !userPos ||
      !destLoc ||
      !route ||
      route.length < 2 ||
      rerouteInFlightRef.current
    ) {
      offRouteSinceRef.current = null;
      return;
    }

    const projection = distanceAlongRoute([userPos.lat, userPos.lng], route);
    if (!projection || projection.offsetM <= 75) {
      offRouteSinceRef.current = null;
      return;
    }

    const now = Date.now();
    if (offRouteSinceRef.current == null) {
      offRouteSinceRef.current = now;
      return;
    }
    if (now - offRouteSinceRef.current < 8_000) return;
    if (now - lastOffRouteRerouteRef.current < 45_000) return;

    const remainingStops = stops
      .filter((s) => s.loc)
      .map((s) => [s.loc!.lat, s.loc!.lng] as [number, number]);
    const waypoints: [number, number][] = [
      [userPos.lat, userPos.lng],
      ...remainingStops,
      [destLoc.lat, destLoc.lng],
    ];

    rerouteInFlightRef.current = true;
    lastOffRouteRerouteRef.current = now;
    offRouteSinceRef.current = null;
    setRerouteAlert("Off route. Finding a new route...");
    speakNav("Off route. Finding a new route.", {
      priority: "alert",
      dedupeKey: "off-route-reroute",
      dedupeMs: 30_000,
    });

    (async () => {
      try {
        const zones = [
          ...buildAvoidZones(incidents, avoidPrefsRef.current),
          ...userAvoidZonesForRouting(),
        ];
        const directRoute = await getMultiStopRoute(ORS_API_KEY, activeMode, waypoints);
        if (!directRoute) return;
        const safeRoute = zones.length > 0
          ? await getMultiStopRoute(ORS_API_KEY, activeMode, waypoints, buildAvoidPolygons(zones))
          : null;
        const best = safeRoute || directRoute;
        const routeData: RouteData = {
          normal: directRoute,
          safe: safeRoute,
          avoidZones: zones,
          chosen: best,
          chosenLabel: safeRoute ? "Safer" : SAFEST_ROUTE_ONLY_UI ? "Route" : "Fastest",
        };
        handleRoutesChange(routeData);
        setRouteInfo({
          isSafe: !!safeRoute,
          distanceKm: best.distanceKm,
          durationMin: best.durationMin,
          nearbyCount: zones.length,
        });
        activeRouteRef.current = best.geometry;
        onTripActive?.(true, best.geometry, activeMode, best.steps, {
          distanceKm: best.distanceKm,
          durationMin: best.durationMin,
          nearbyCount: zones.length,
          isSafe: !!safeRoute,
          origin: { display_name: "Your location", lat: userPos.lat, lng: userPos.lng },
          dest: { display_name: destLoc.display_name, lat: destLoc.lat, lng: destLoc.lng },
        });
        setRerouteAlert("Route updated from your current location");
        window.setTimeout(() => setRerouteAlert(null), 5000);
      } catch {
        setRerouteAlert(null);
      } finally {
        rerouteInFlightRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPos, view]);

  // Flush the latest progress into the resume snapshot whenever it
  // moves. Throttled to whole-percent boundaries so we don't write to
  // localStorage on every animation frame.
  const lastProgressFlushRef = useRef(0);
  useEffect(() => {
    if (view !== "trip") return;
    const pct = Math.floor(tripProgress * 100);
    if (pct === lastProgressFlushRef.current) return;
    lastProgressFlushRef.current = pct;
    updateTripProgress(tripProgress);
  }, [view, tripProgress]);

  const resetTrip = useCallback(() => {
    setRouteInfo(null);
    setDestLoc(null);
    setDestQuery("");
    setStops([]);
    setView("search");
    setActiveDesktopPanel(null);
    setDrawerOpen(false);
    onRoutesChange(null);
    onTripActive?.(false);
    clearTripSnapshot();
    onPreviewPins?.(originLoc, null);
    onPreviewWaypoints?.(null);
    activeRouteRef.current = null;
  }, [onRoutesChange, onTripActive, onPreviewPins, onPreviewWaypoints, originLoc]);

  useEffect(() => {
    const onEndTrip = () => resetTrip();
    window.addEventListener("pp:end-trip", onEndTrip);
    return () => window.removeEventListener("pp:end-trip", onEndTrip);
  }, [resetTrip]);

  const highCount = incidents.filter((i) => i.s_base >= 0.7).length;
  const showStatsDetails = !isMobile || statsOpen;

  const innerContent = (
    <>
      {view === "search" && (
          <>
            <SearchInput
              onFlyTo={onFlyTo}
              onDirections={openDirections}
              timeFilterHours={timeFilterHours}
              onSelectIncident={onSelectIncident}
              onPlaceSelected={handlePlaceSelected}
            />

            {selectedPlace ? (
              // Tap-result place card. Mounted only while a place is
              // selected; replaces the default search shelf (chips,
              // saved places, trip history) so the user isn't
              // overwhelmed and the Directions CTA is the hero.
              <SearchedPlaceCard
                place={selectedPlace}
                userPos={userPos}
                onDirections={openSelectedPlaceDirections}
                onStart={startTripFromPlace}
                onClose={clearSelectedPlacePreview}
              />
            ) : (
              <>
                {/* OSM Overpass-backed "Find nearby" chips. Self-contained;
                    results render inline. Sits above the directions CTA
                    so the row reads as "search → nearby → directions". */}
                <NearbyChips
                  userPos={userPos}
                  onFlyTo={onFlyTo}
                  onDirections={openDirections}
                  onPlaceSelected={handlePlaceSelected}
                />

                <button
                  onClick={() => openDirections()}
                  className="mx-4 mb-2 w-[calc(100%-2rem)] flex items-center gap-3 px-4 py-2.5 rounded-xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 transition-all text-sm text-blue-500 font-medium"
                >
                  <Navigation className="w-4 h-4" />
                  Get Safe Directions
                </button>

                <SavedPlaces onFlyTo={onFlyTo} onDirections={openDirections} userPos={userPos} />

                <TripHistory
              onReplay={(entry) => {
                if (!entry.origin || !entry.dest) return;
                // Reuse the existing pp:resume-trip codepath so the
                // replay flow is identical to "resume previous trip".
                window.dispatchEvent(
                  new CustomEvent("pp:resume-trip", {
                    detail: {
                      origin: entry.origin,
                      dest: entry.dest,
                      stops: [],
                      mode: entry.mode,
                    },
                  })
                );
              }}
            />

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

              {isMobile && (
                <button
                  type="button"
                  onClick={() => setStatsOpen((v) => !v)}
                  className="w-full flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
                  style={{
                    background: "var(--panel-input-bg)",
                    border: "1px solid var(--panel-border)",
                    color: "var(--panel-text-secondary)",
                  }}
                  aria-expanded={statsOpen}
                >
                  <span>More local activity</span>
                  <ChevronDown
                    className="w-3.5 h-3.5 transition-transform"
                    style={{ transform: statsOpen ? "rotate(180deg)" : "none" }}
                  />
                </button>
              )}

              {/* Today's hourly sparkline */}
              {showStatsDetails && hourlyData.length > 0 && hourlyData.some((v) => v > 0) && (
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
              {showStatsDetails && categoryBreakdown.length > 0 && (
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
              {showStatsDetails && hotNeighborhoods.length > 0 && (
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
                  <Radio className="w-3 h-3" /> {timeFilterLabel ? `Incidents · ${timeFilterLabel}` : "Recent Incidents"}
                </h3>
              </div>
              <IncidentFeed
                incidents={incidents}
                selectedId={selectedId ?? null}
                onSelect={(id) => {
                  onSelectIncident?.(id);
                }}
                onViewOnMap={(id) => {
                  onSelectIncident?.(id);
                  const inc = incidents.find((i) => i.id === id);
                  if (inc?.lat != null && inc?.lng != null) onFlyTo(inc.lat, inc.lng);
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
          </>
        )}

        {view === "directions" && (
          // Wrap in a scrollable container so the panel content
          // (mode tabs → avoid pills → severity → within → origin/
          // dest rows → Start button → route preview → step list)
          // is reachable inside the bottom sheet. Without this the
          // sheet's overflow-hidden clips everything past ~55vh and
          // the user can't get to the Start button. `flex-1 min-h-0`
          // lets the panel claim the remaining sheet height; the
          // overflow lives on this wrapper, not inside the panel,
          // so the panel's own layout assumptions stay untouched. */}
          <div
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
            style={{
              WebkitOverflowScrolling: "touch",
              paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)",
            }}
          >
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
                setActiveDesktopPanel(null);
                setDrawerOpen(false);
                setDestLoc(null);
                setDestQuery("");
                setStops([]);
                handleRoutesChange(null);
                onPreviewPins?.(originLoc, null);
                onPreviewWaypoints?.(null);
              }}
              onFlyTo={onFlyTo}
              onRoutesChange={handleRoutesChange}
              onPreviewPins={onPreviewPins}
              onPreviewWaypoints={onPreviewWaypoints}
              onStartTrip={startTrip}
              avoidPrefs={avoidPrefs}
              onAvoidPrefsChange={setAvoidPrefs}
              timeFilterHours={timeFilterHours ?? 24}
            />
          </div>
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
          gpsStatus={gpsStatus}
          onResetTrip={resetTrip}
          recentIncidents={incidents.slice(0, 12)}
          onSelectIncident={(id) => onSelectIncident?.(id)}
          onFlyTo={onFlyTo}
          onShareEta={async () => {
            const dest = destLocRef.current;
            const geom = activeRouteRef.current;
            if (!dest || !geom || geom.length < 2 || !routeInfo) return false;
            const remainingMin = Math.max(1, Math.ceil(routeInfo.durationMin * (1 - tripProgress)));
            const url = buildTripShareUrl({
              name: senderDisplayName.current || undefined,
              destination: [dest.lat, dest.lng],
              mode: activeMode,
              etaEpochMs: Date.now() + remainingMin * 60_000,
              sentAtEpochMs: Date.now(),
              geometry: geom,
            });
            const ok = await nativeShare({
              title: "Live ETA",
              text: `On my way · ETA ${remainingMin} min`,
              url,
              dialogTitle: "Share live ETA",
            });
            return ok;
          }}
        />
      )}
    </>
  );

  const placeCardOpen = view === "search" && selectedPlace !== null;
  const mobileExpandKey = placeCardOpen
    ? `${view}:place:${selectedPlace.lat.toFixed(5)},${selectedPlace.lng.toFixed(5)}`
    : view;

  if (isMobile) {
    if (view === "trip") {
      return null;
    }
    return (
      <MobileSheet
        open={mobileOpen}
        onOpenChange={(o) => onMobileOpenChange?.(o)}
        expandKey={mobileExpandKey}
        coverBottomNav={view !== "search"}
        preferExpanded={false}
      >
        {innerContent}
      </MobileSheet>
    );
  }

  const selectDesktopPanel = (panel: Exclude<DesktopPanel, null>) => {
    setActiveDesktopPanel(panel);
    setDrawerOpen(true);
    if (panel === "directions" && view !== "trip") setView("directions");
  };

  const closeDesktopDrawer = () => {
    if (view === "directions") {
      setView("search");
      setDestLoc(null);
      setDestQuery("");
      setStops([]);
      handleRoutesChange(null);
      onPreviewPins?.(originLoc, null);
      onPreviewWaypoints?.(null);
    }
    setActiveDesktopPanel(null);
    setDrawerOpen(false);
  };

  const railItems: { id: Exclude<DesktopPanel, null>; label: string; Icon: LucideIcon }[] = [
    { id: "menu", label: "Ask Pulse", Icon: Sparkles },
    { id: "saved", label: "Saved", Icon: Bookmark },
    { id: "recents", label: "Recents", Icon: History },
    { id: "feed", label: "Live feed", Icon: Radio },
    { id: "directions", label: "Routes", Icon: Navigation },
  ];

  const drawerTitle =
    view === "directions" ? "Directions" :
    view === "trip" ? "Trip" :
    selectedPlace ? selectedPlace.name :
    activeDesktopPanel === "feed" ? "Live incidents" :
    activeDesktopPanel === "saved" ? "Saved" :
    activeDesktopPanel === "recents" ? "Recents" :
    "CityPulse";

  const menuRow = (Icon: LucideIcon, label: string, onClick: () => void, hint?: string) => (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-4 px-5 py-3 text-sm transition-colors text-left"
      style={{ color: "var(--panel-text-secondary)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Icon className="w-5 h-5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-[11px] shrink-0" style={{ color: "var(--panel-text-muted)" }}>{hint}</span>}
    </button>
  );

  const desktopStatsStrip = (
    <div className="px-4 py-3 space-y-3" style={{ borderBottom: "1px solid var(--panel-border)" }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-[11px] text-green-500 font-medium">LIVE</span>
          <span className="text-[11px]" style={{ color: "var(--panel-text-muted)" }}>·</span>
          <span className="text-[11px] font-semibold" style={{ color: "var(--panel-text)" }}>{incidents.length}</span>
          <span className="text-[11px]" style={{ color: "var(--panel-text-secondary)" }}>incidents</span>
        </div>
        <div
          className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
            trendPct > 0 ? "bg-red-500/10 text-red-400" : trendPct < 0 ? "bg-green-500/10 text-green-400" : ""
          }`}
          style={trendPct === 0 ? { background: "var(--panel-input-bg)", color: "var(--panel-text-muted)" } : undefined}
        >
          {trendPct > 0 ? <TrendingUp className="w-3 h-3" /> : trendPct < 0 ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
          {trendPct > 0 ? "+" : ""}{trendPct}%
        </div>
      </div>
      {highCount > 0 && (
        <div className="flex items-center gap-1.5">
          <Flame className="w-3 h-3 text-amber-500" />
          <span className="text-[10px] text-amber-500 font-medium">{highCount} critical</span>
        </div>
      )}
      {hourlyData.length > 0 && hourlyData.some((v) => v > 0) && (
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-wider mb-1" style={{ color: "var(--panel-text-muted)" }}>
            Today&apos;s Activity
          </p>
          <Sparkline data={hourlyData} color="#3b82f6" width={340} height={28} filled />
        </div>
      )}
    </div>
  );

  const desktopIncidentFeed = (
    <>
      {desktopStatsStrip}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: "var(--panel-text-muted)" }}>
            <Radio className="w-3 h-3" /> {timeFilterLabel ? `Incidents · ${timeFilterLabel}` : "Recent Incidents"}
          </h3>
        </div>
        <IncidentFeed
          incidents={incidents}
          selectedId={selectedId ?? null}
          onSelect={(id) => {
            onSelectIncident?.(id);
          }}
          onViewOnMap={(id) => {
            onSelectIncident?.(id);
            const inc = incidents.find((i) => i.id === id);
            if (inc?.lat != null && inc?.lng != null) onFlyTo(inc.lat, inc.lng);
          }}
        />
      </div>
    </>
  );

  const desktopDrawerContent = (() => {
    if (view === "directions") {
      return (
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
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
            onBack={closeDesktopDrawer}
            onFlyTo={onFlyTo}
            onRoutesChange={handleRoutesChange}
            onPreviewPins={onPreviewPins}
            onPreviewWaypoints={onPreviewWaypoints}
            onStartTrip={startTrip}
            avoidPrefs={avoidPrefs}
            onAvoidPrefsChange={setAvoidPrefs}
            timeFilterHours={timeFilterHours ?? 24}
          />
        </div>
      );
    }

    if (view === "trip" && routeInfo) {
      return (
        <>
          {rerouteAlert && (
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
          <TripHUD
            routeInfo={routeInfo}
            originQuery={originQuery}
            destQuery={destQuery}
            stops={stops}
            activeMode={activeMode}
            tripProgress={tripProgress}
            gpsStatus={gpsStatus}
            onResetTrip={resetTrip}
            recentIncidents={incidents.slice(0, 12)}
            onSelectIncident={(id) => onSelectIncident?.(id)}
            onFlyTo={onFlyTo}
            onShareEta={async () => {
              const dest = destLocRef.current;
              const geom = activeRouteRef.current;
              if (!dest || !geom || geom.length < 2 || !routeInfo) return false;
              const remainingMin = Math.max(1, Math.ceil(routeInfo.durationMin * (1 - tripProgress)));
              const url = buildTripShareUrl({
                name: senderDisplayName.current || undefined,
                destination: [dest.lat, dest.lng],
                mode: activeMode,
                etaEpochMs: Date.now() + remainingMin * 60_000,
                sentAtEpochMs: Date.now(),
                geometry: geom,
              });
              return nativeShare({
                title: "Live ETA",
                text: `On my way · ETA ${remainingMin} min`,
                url,
                dialogTitle: "Share live ETA",
              });
            }}
          />
        </>
      );
    }

    if (view === "search" && selectedPlace) {
      return (
        <div className="overflow-y-auto pb-4 pt-3">
          <SearchedPlaceCard
            place={selectedPlace}
            userPos={userPos}
            onDirections={openSelectedPlaceDirections}
            onStart={startTripFromPlace}
            onClose={clearSelectedPlacePreview}
          />
        </div>
      );
    }

    if (activeDesktopPanel === "feed") return desktopIncidentFeed;
    if (activeDesktopPanel === "saved") {
      return (
        <div className="overflow-y-auto pb-4">
          <SavedPlaces onFlyTo={onFlyTo} onDirections={openDirections} userPos={userPos} />
        </div>
      );
    }
    if (activeDesktopPanel === "recents") {
      return (
        <div className="overflow-y-auto pb-4">
          <TripHistory
            onReplay={(entry) => {
              if (!entry.origin || !entry.dest) return;
              window.dispatchEvent(
                new CustomEvent("pp:resume-trip", {
                  detail: {
                    origin: entry.origin,
                    dest: entry.dest,
                    stops: [],
                    mode: entry.mode,
                  },
                })
              );
            }}
          />
        </div>
      );
    }

    return (
      <div className="overflow-y-auto pb-4">
        <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--panel-border)" }}>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--panel-text-muted)" }}>Navigation</p>
        </div>
        {menuRow(Sparkles, "Ask Pulse", () => {
          closeDesktopDrawer();
          openAskPulseTab();
        })}
        {menuRow(Bookmark, "Saved places", () => selectDesktopPanel("saved"))}
        {menuRow(History, "Recent trips", () => selectDesktopPanel("recents"))}
        {menuRow(Radio, "Live incident feed", () => selectDesktopPanel("feed"), incidents.length > 0 ? String(incidents.length) : undefined)}
        {menuRow(Navigation, "Get safe directions", () => openDirections())}
        {menuRow(Bell, "Alerts inbox", () => {
          const url = new URL(window.location.href);
          url.searchParams.set("inbox", "list");
          window.history.replaceState({}, "", url.toString());
          window.dispatchEvent(new PopStateEvent("popstate"));
        })}
        <div className="h-px my-2" style={{ background: "var(--panel-border)" }} />
        {menuRow(Layers, "Layers and basemap", () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true })))}
        {menuRow(Settings, "Search settings", () => window.dispatchEvent(new CustomEvent("pp:focus-search")))}
        {menuRow(Database, "Your data in CityPulse", () => selectDesktopPanel("saved"))}
        <div className="h-px my-2" style={{ background: "var(--panel-border)" }} />
        {menuRow(Share2, "Share map", () => {
          void nativeShare({
            title: "CityPulse",
            text: "Live safety-aware map",
            url: window.location.href,
            dialogTitle: "Share CityPulse",
          });
        })}
        {menuRow(Printer, "Print", () => window.print())}
        {menuRow(CircleHelp, "Help and feedback", () => window.dispatchEvent(new CustomEvent("pp:open-feedback")))}
      </div>
    );
  })();

  return (
    <div className="absolute top-0 left-0 bottom-0 z-[1000] pointer-events-none">
      <div
        className="absolute top-0 left-0 bottom-0 w-[72px] flex flex-col items-center pointer-events-auto shadow-xl"
        style={{
          background: "var(--panel-bg)",
          borderRight: "1px solid var(--panel-border)",
          boxShadow: "2px 0 14px var(--panel-shadow)",
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (desktopPanelVisible && activeDesktopPanel === "menu") closeDesktopDrawer();
            else selectDesktopPanel("menu");
          }}
          className="mt-5 mb-4 w-10 h-10 flex items-center justify-center rounded-full transition-colors"
          style={{ color: "var(--panel-text-secondary)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          aria-label={desktopPanelVisible && activeDesktopPanel === "menu" ? "Close menu" : "Open menu"}
        >
          {desktopPanelVisible && activeDesktopPanel === "menu" ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>

        <div className="flex-1 w-full flex flex-col items-center gap-1">
          {railItems.map(({ id, label, Icon }) => {
            const active = activeDesktopPanel === id || (id === "directions" && (view === "directions" || view === "trip"));
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  if (id === "menu") {
                    closeDesktopDrawer();
                    openAskPulseTab();
                    return;
                  }
                  selectDesktopPanel(id);
                }}
                className="w-full min-h-[58px] px-1 flex flex-col items-center justify-center gap-1 transition-colors text-[11px] font-medium"
                style={{
                  color: active ? "#3b82f6" : "var(--panel-text-secondary)",
                  background: active ? "rgba(59,130,246,0.10)" : "transparent",
                }}
                title={label}
                aria-label={label}
              >
                <Icon className="w-5 h-5" />
                <span className="max-w-full truncate">{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {view === "search" && (
        <div
          className="absolute top-0 z-10 pointer-events-auto"
          style={{
            left: `calc(var(--pp-map-sidebar-width, ${MAP_RAIL_WIDTH}px) + 0.25rem)`,
            width: "min(440px, calc(100vw - var(--pp-map-sidebar-width, 72px) - 2rem))",
          }}
        >
          <SearchInput
            onFlyTo={onFlyTo}
            onDirections={openDirections}
            timeFilterHours={timeFilterHours}
            onSelectIncident={onSelectIncident}
            onPlaceSelected={handlePlaceSelected}
          />
        </div>
      )}

      {desktopPanelVisible && (
        <div
          className="absolute top-0 bottom-0 left-[72px] flex flex-col pointer-events-auto backdrop-blur-xl shadow-2xl"
          style={{
            width: sidebarWidthPx,
            background: "var(--panel-bg)",
            borderRight: "1px solid var(--panel-border)",
            boxShadow: "4px 0 24px var(--panel-shadow)",
          }}
        >
          {view !== "directions" && (
            <div className="h-16 px-5 flex items-center justify-between shrink-0" style={{ borderBottom: "1px solid var(--panel-border)" }}>
              <div className="min-w-0">
                <p className="text-base font-semibold truncate" style={{ color: "var(--panel-text)" }}>{drawerTitle}</p>
                {view === "search" && (
                  <p className="text-[11px] truncate" style={{ color: "var(--panel-text-muted)" }}>
                    {activeDesktopPanel === "feed" ? "Scanner incidents and map pins" : "Map tools and saved places"}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={closeDesktopDrawer}
                className="w-9 h-9 flex items-center justify-center rounded-full transition-colors shrink-0"
                style={{ color: "var(--panel-text-secondary)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                aria-label="Close drawer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          )}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{desktopDrawerContent}</div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            title="Drag to resize"
            className="absolute top-0 right-0 z-20 w-2 h-full cursor-col-resize touch-none pointer-events-auto flex justify-center -mr-px"
            onPointerDown={onSidebarResizePointerDown}
          >
            <span
              className="w-px h-[min(100%,12rem)] self-center rounded-full bg-white/25 opacity-80 hover:opacity-100 hover:bg-white/40 transition-[opacity,background-color]"
              aria-hidden
            />
          </div>
        </div>
      )}
    </div>
  );
}
