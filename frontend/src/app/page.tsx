"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, Suspense } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield,
  Eye,
  X,
  Layers,
  Flame,
  Siren,
  HeartPulse,
  Car,
  Volume2,
  Clock,
  Sun,
  Moon,
  Monitor,
  BarChart3,
  Menu,
  List,
  Map as MapIcon,
  LocateFixed,
  House,
  TrendingUp,
  TrendingDown,
  MapPin,
  Radio,
  Lock,
  Bell,
  Search,
  Crosshair,
  Activity,
  MessageCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import IncidentFeed from "@/components/IncidentFeed";
import FeedPullRefresh from "@/components/FeedPullRefresh";
import FeedAudioMiniPlayer from "@/components/FeedAudioMiniPlayer";
import { getCurrentPosition } from "@/lib/native";
import { withAlpha } from "@/lib/colors";
import { activeNowCount } from "@/lib/analytics";
import { INCIDENT_CATEGORY_GROUPS, toggleCategoryGroupSelection } from "@/lib/incident-category-groups";
import SearchSidebar from "@/components/SearchSidebar";
import { type RouteData } from "@/components/RoutePanel";
import SafetyScoreCard from "@/components/SafetyScoreCard";
import LocationPeekCard from "@/components/LocationPeekCard";
import AlertToast from "@/components/AlertToast";
import IncidentDetail from "@/components/IncidentDetail";
import ClusterListPanel from "@/components/ClusterListPanel";
import AnalyticsPanel from "@/components/AnalyticsPanel";
import AskPulsePanel from "@/components/AskPulsePanel";
import MoreMenu from "@/components/MoreMenu";
import DistrictCard from "@/components/DistrictCard";
import OfflineTilesPanel from "@/components/OfflineTilesPanel";
import MeasureToolPanel from "@/components/MeasureToolPanel";
import MapSnapshotButton from "@/components/MapSnapshotButton";
import ReminderRunner from "@/components/ReminderRunner";
import ReminderBanner from "@/components/ReminderBanner";
import FilterPresetsBar from "@/components/FilterPresetsBar";
import ManeuverChip from "@/components/ManeuverChip";
import TurnList from "@/components/TurnList";
import RecenterPill from "@/components/RecenterPill";
import AlongRoutePanel from "@/components/AlongRoutePanel";
import ParkingApproachPill from "@/components/ParkingApproachPill";
import SafetyEscapeButton from "@/components/SafetyEscapeButton";
import CompassIndicator from "@/components/CompassIndicator";
import SafetyEscapePanel from "@/components/SafetyEscapePanel";
import UndoToastHost from "@/components/UndoToastHost";
import KeyboardShortcutsHelp from "@/components/KeyboardShortcutsHelp";
import InstallPrompt from "@/components/InstallPrompt";
import MapGesturesTour from "@/components/MapGesturesTour";
import FeedbackForm from "@/components/FeedbackForm";
import CommuteNotifier from "@/components/CommuteNotifier";
import LiveSharePill from "@/components/LiveSharePill";
import SharedTripCard from "@/components/SharedTripCard";
import SpeedChip from "@/components/SpeedChip";
import TripRecapCard, { type TripRecap } from "@/components/TripRecapCard";
import OffscreenIncidentChip from "@/components/OffscreenIncidentChip";
import IncidentAheadChip from "@/components/IncidentAheadChip";
import AlertsInbox from "@/components/AlertsInbox";
import { recordAlert, subscribeAlerts, unreadCount } from "@/lib/alerts-inbox";
import { setAppBadge } from "@/lib/app-badge";
import { loadMutedCategories } from "@/lib/alert-mutes";
import { recordTrip, updateTrip, type TripHistoryEntry } from "@/lib/trip-history";
import { getParkedPin, subscribeParkedPin, type ParkedPin } from "@/lib/parked-pin";
import { setPref } from "@/lib/prefs-sync";
import ParkedPinPill from "@/components/ParkedPinPill";
import {
  fetchPoisInBounds,
  SAFETY_POI_CATEGORIES,
  NEARBY_POI_CATEGORIES,
  type SafetyPoiCategory,
  type NearbyPoiCategory,
} from "@/lib/overpass";
import { useSavedDestinations } from "@/hooks/useSavedDestinations";
import ResumeTripPill from "@/components/ResumeTripPill";
import { loadTripSnapshot, clearTripSnapshot, type TripResumeSnapshot } from "@/lib/trip-resume";
import { distanceAlongRoute } from "@/lib/routing";
import { notifyIfBackgrounded } from "@/lib/notifications";
import { getSeverity } from "@/lib/severity";
import { useDeviceHeading } from "@/hooks/useDeviceHeading";
import { useGpsSpeed } from "@/hooks/useGpsSpeed";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useMobileHomeRedirect } from "@/hooks/useMobileHomeRedirect";
import { useMobilePrimaryTabSwipe } from "@/hooks/useMobilePrimaryTabSwipe";
import MobileBottomNav, { MOBILE_NAV_HEIGHT_PX } from "@/components/MobileBottomNav";
import InboxUrlSync, { type InboxPanel } from "@/components/InboxUrlSync";
import { decodeTripToken, type DecodedTripToken } from "@/lib/share-trip";
import type { ManeuverStep } from "@/lib/routing";
import type { MapHandle, WaypointPin, BasemapStyle } from "@/components/IncidentMap";
import { useVectorTiles } from "@/lib/vector-basemap";
import {
  fetchIncidents,
  fetchSummary,
  fetchStats,
  type Incident,
  type StatsResponse,
} from "@/lib/api";
import {
  TIME_FILTERS,
  normalizeTimeFilterHours,
  sinceIsoForTimeFilterHours,
  timeFilterNeedsExtendedFetch,
} from "@/lib/time-filters";
import { EXTENDED_HISTORY_PAGE_SIZE } from "@/lib/firestore";
import { useTheme } from "@/lib/theme";
import AuthBar from "@/components/AuthBar";
import { isFirebaseConfigured } from "@/lib/firebase";
import {
  fetchExtendedHistoryPage,
  fetchIncidentCount,
  subscribeIncidents,
} from "@/lib/firestore";
import { enrichIncidents } from "@/lib/incident-weights";
import { loadCachedIncidents, saveCachedIncidents } from "@/lib/incident-snapshot-cache";
import { apiUrl, fetchPublicApi } from "@/lib/public-api-base";
import { buildLocalSummary } from "@/lib/local-summary";
import {
  getNeighborhood,
  getNeighborhoodBySlug,
  incidentsInNeighborhood,
  NEIGHBORHOODS,
  type Neighborhood,
} from "@/lib/neighborhoods";
import {
  DISTRICTS,
  getDistrictBySlug,
  incidentsInDistrict,
  type District,
} from "@/lib/districts";
import { getCurrentCity } from "@/lib/pulse-cities";
import { assessSafety } from "@/lib/search";
import Sparkline from "@/components/charts/Sparkline";
import PulseNetworkNav from "@/components/PulseNetworkNav";
import { useAuth } from "@/contexts/AuthContext";
import UpgradePrompt, { ProBadge } from "@/components/UpgradePrompt";
import { onUpgradeRequested } from "@/lib/upgrade";

const WEIGHT_REFRESH_MS = 15000;

function statsFromIncidents(incidents: Incident[]): StatsResponse {
  const inhibitor_stats: Record<string, number> = {};
  for (const i of incidents) {
    const s = i.inhibitor_status;
    inhibitor_stats[s] = (inhibitor_stats[s] ?? 0) + 1;
  }
  return {
    total_incidents: incidents.length,
    inhibitor_stats,
  };
}

const CATEGORY_PILL_ICONS = [Siren, HeartPulse, Car, Flame, Volume2] as const;

const CATEGORY_PILLS = INCIDENT_CATEGORY_GROUPS.map((pill, i) => ({
  ...pill,
  icon: CATEGORY_PILL_ICONS[i],
}));

const STORAGE_TIME_FILTER_HOURS = "pulse_time_filter_hours";
const STORAGE_ACTIVE_CATS = "pulse_active_cats";

function readStoredTimeFilterHours(): number {
  if (typeof window === "undefined") return 1;
  try {
    const raw = sessionStorage.getItem(STORAGE_TIME_FILTER_HOURS);
    if (raw == null || raw === "") return 1;
    const n = Number(raw);
    if (Number.isNaN(n)) return 1;
    return normalizeTimeFilterHours(n);
  } catch {
    return 1;
  }
}

function readStoredActiveCats(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = sessionStorage.getItem(STORAGE_ACTIVE_CATS);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) return new Set();
    return new Set(arr);
  } catch {
    return new Set();
  }
}

const DEFAULT_FEED_LABELS: Record<string, string> = {
  "4603": "Citywide",
  "17310": "Central",
  "21297": "East",
  "45495": "Northeast",
  "18836": "Northwest",
  "15102": "South",
  "15195": "SW/West",
  "34250": "PFD South",
  "15747": "PFD North",
};

const IncidentMap = dynamic(() => import("@/components/IncidentMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center" style={{ background: "var(--map-bg)" }}>
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
        <p className="text-xs font-medium" style={{ color: "var(--panel-text-muted)" }}>Loading map...</p>
      </div>
    </div>
  ),
});

const POLL_INTERVAL = 12000;

const THEME_OPTIONS = [
  { id: "auto" as const, icon: Monitor, label: "Auto" },
  { id: "light" as const, icon: Sun, label: "Light" },
  { id: "dark" as const, icon: Moon, label: "Dark" },
];

/**
 * Mobile-aware home shell: per the build plan (§4) mobile users land
 * on `/feed` by default while desktop users land on the map. The
 * heavy `MapHome` component below isn't even mounted while we're
 * deciding (or while we're redirecting), which avoids:
 *   - briefly painting the full map UI on a phone before bouncing
 *   - eagerly subscribing to Firestore / spinning up Leaflet on a
 *     visit that is about to leave the route anyway
 */
function HomeInner() {
  const decision = useMobileHomeRedirect();
  if (decision !== "stay") return null;
  return <MapHome />;
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeInner />
    </Suspense>
  );
}

function MapHome() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { mode, resolved, setMode, colorBlindSafe, setColorBlindSafe } = useTheme();
  const { destinations: savedDestinations, lists: savedLists } = useSavedDestinations();
  const isDark = resolved === "dark";
  const [firestoreAvailable, setFirestoreAvailable] = useState(() => isFirebaseConfigured());
  const useFirestoreData = firestoreAvailable;
  const { isPro, loading: authLoading } = useAuth();

  const [cityDisplayName, setCityDisplayName] = useState(() => {
    if (typeof window !== "undefined") return getCurrentCity().name;
    return "";
  });
  useEffect(() => {
    setCityDisplayName(getCurrentCity().name);
  }, [pathname, searchParams]);

  const [incidents, setIncidents] = useState<Incident[]>(() => {
    if (typeof window === "undefined") return [];
    return loadCachedIncidents(getCurrentCity().slug)?.incidents ?? [];
  });
  /** Latest map pins for API summary/stats fallbacks when Firestore owns the map. */
  const incidentsForStatsRef = useRef<Incident[]>([]);
  /** After Firestore paints pins, re-fetch summary/stats once (initial API call saw ref []). */
  const statsAfterFirestoreRef = useRef(false);
  useEffect(() => {
    incidentsForStatsRef.current = incidents;
  }, [incidents]);

  useEffect(() => {
    if (incidents.length === 0) return;
    saveCachedIncidents(getCurrentCity().slug, incidents);
  }, [incidents]);
  /** Older incidents pulled on-demand when the user picks a 1w+ time
   *  filter. Kept separate from the live `incidents` slice so the live
   *  Firestore listener doesn't clobber them on every snapshot tick. */
  const [extendedIncidents, setExtendedIncidents] = useState<Incident[]>([]);
  /** Current map viewport. Used only to scope the badge counter to
   *  what's actually on screen — every other downstream consumer
   *  (clusters, district counts, alerts) still uses the city-wide
   *  filtered set. */
  const [mapBounds, setMapBounds] = useState<{
    north: number;
    south: number;
    east: number;
    west: number;
  } | null>(null);
  /** Server-side count of all incidents in the current extended window
   *  (uses Firestore's count() aggregation — 1 read regardless of N).
   *  null when no extended fetch is active; -1 if the count query
   *  itself fails. Drives the "X / Y loaded" progress badge. */
  const [extendedTotal, setExtendedTotal] = useState<number | null>(null);
  /** True while paged extended fetch is still streaming pages. */
  const [extendedLoading, setExtendedLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [routes, setRoutes] = useState<RouteData | null>(null);
  /** Top-level view tab: "map", "feed", "analytics", "ask". Developer API docs live at `/use-cases/api`. */
  const [viewTab, setViewTab] = useState<"map" | "feed" | "analytics" | "ask">(() => {
    if (typeof window === "undefined") return "map";
    const viewHint = new URLSearchParams(window.location.search).get("view");
    if (viewHint === "map" || viewHint === "feed" || viewHint === "analytics" || viewHint === "ask") {
      return viewHint;
    }
    const saved = sessionStorage.getItem("pulse_view_tab");
    if (saved === "map" || saved === "feed" || saved === "analytics" || saved === "ask") {
      return saved;
    }
    return "map";
  });

  useEffect(() => {
    const saved = sessionStorage.getItem("pulse_view_tab");
    if (saved === "api") {
      sessionStorage.setItem("pulse_view_tab", "map");
      return;
    }
    const viewHint = new URLSearchParams(window.location.search).get("view");
    if (viewHint === "map" || viewHint === "feed" || viewHint === "analytics" || viewHint === "ask") {
      setViewTab(viewHint);
      return;
    }
    if (saved === "map" || saved === "feed" || saved === "analytics" || saved === "ask") {
      setViewTab(saved);
    }
  }, []);

  useEffect(() => {
    sessionStorage.setItem("pulse_view_tab", viewTab);
  }, [viewTab]);

  useEffect(() => {
    const v = searchParams.get("view");
    if (v === "map" || v === "feed" || v === "analytics" || v === "ask") {
      setViewTab(v);
    }
  }, [searchParams]);
  const [timeFilter, setTimeFilter] = useState<number>(1);
  const [activeCats, setActiveCats] = useState<Set<string>>(() => new Set());

  /** Restore after SSR so we do not clobber sessionStorage in the persist effect before this runs. */
  useLayoutEffect(() => {
    setTimeFilter(readStoredTimeFilterHours());
    setActiveCats(readStoredActiveCats());
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_TIME_FILTER_HOURS, String(timeFilter));
    } catch {
      /* ignore quota / private mode */
    }
  }, [timeFilter]);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_ACTIVE_CATS, JSON.stringify([...activeCats]));
    } catch {
      /* ignore */
    }
  }, [activeCats]);

  /** If auth says non‑Pro, drop stored lookback to the largest free window (1h). */
  useEffect(() => {
    if (authLoading) return;
    if (isPro) return;
    const canon = normalizeTimeFilterHours(timeFilter);
    const row =
      TIME_FILTERS.find((t) => t.hours === canon) ??
      TIME_FILTERS.find(
        (t) => Number.isFinite(t.hours) && Math.abs(t.hours - canon) < 1e-4
      );
    if (row?.pro) setTimeFilter(1);
  }, [isPro, authLoading, timeFilter]);

  const [mapTap, setMapTap] = useState<{ lat: number; lng: number } | null>(null);
  // Long-press / right-click anchor for the LocationPeekCard. Cleared
  // automatically by the useEffect below whenever a competing overlay
  // takes the bottom-left card slot, so we don't end up with two
  // panels stacked on top of each other.
  const [peekAnchor, setPeekAnchor] = useState<{ lat: number; lng: number } | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  // Resume-trip prompt — populated on mount if there's a < 2h-old trip
  // snapshot in localStorage. The pill stays up until the user either
  // resumes (dispatches pp:resume-trip) or dismisses (clears snapshot).
  const [resumeSnap, setResumeSnap] = useState<TripResumeSnapshot | null>(null);
  useEffect(() => {
    const snap = loadTripSnapshot();
    if (snap) setResumeSnap(snap);
  }, []);
  const userHeading = useDeviceHeading(userLocation !== null);

  // Off-screen incident alert — pops a chip whenever a fresh, high-severity
  // incident lands outside the viewport so the user can fly to it. Tracked
  // via a ref because we don't want a render every time we tag an ID as seen.
  const seenIncidentIdsRef = useRef<Set<string>>(new Set());
  const seenInitialisedRef = useRef(false);
  const dismissedAlertIdsRef = useRef<Set<string>>(new Set());
  const [offscreenAlert, setOffscreenAlert] = useState<{
    incident: Incident;
    bearingDeg: number;
  } | null>(null);
  // "Follow-me" mode keeps the map centered on the user's GPS during an
  // active trip. Default OFF on cold load — otherwise the map snaps from
  // the city center to the user's actual GPS the moment SearchBar's
  // watchPosition fires its first fix, which surprises users who landed
  // on (e.g.) sfopulse.com from outside SF and expect to see SF, not
  // their own house. Auto-flipped ON when a trip starts (so the map
  // tracks the driver), and re-enabled by tapping the Re-center pill.
  const [followMe, setFollowMe] = useState(false);
  // Auto-pan the map to the user when their GPS updates *and* a trip is
  // active *and* follow-me hasn't been turned off by manual drag. We use
  // the cheap panTo (no zoom change) instead of flyTo to avoid fighting
  // the user during gentle position adjustments.
  const lastFollowPanRef = useRef<{ lat: number; lng: number; t: number } | null>(null);
  useEffect(() => {
    if (!followMe || !userLocation) return;
    // Limit follow-me pans to one every 1.5s so we don't churn the map
    // animation queue during noisy GPS updates.
    const last = lastFollowPanRef.current;
    const now = performance.now();
    if (last && now - last.t < 1500) {
      const dLat = Math.abs(last.lat - userLocation.lat);
      const dLng = Math.abs(last.lng - userLocation.lng);
      // Skip if movement was tiny (< ~10m) and we panned very recently.
      if (dLat < 0.0001 && dLng < 0.0001) return;
    }
    lastFollowPanRef.current = { lat: userLocation.lat, lng: userLocation.lng, t: now };
    mapRef.current?.panTo?.(userLocation.lat, userLocation.lng);
  }, [followMe, userLocation]);
  const [tripGeometry, setTripGeometry] = useState<[number, number][] | null>(null);
  /** Whether the "Search along route" overlay panel is open. Only
   *  meaningful when a trip is active — toggling closes the panel
   *  when the trip ends so it doesn't persist into a stale state. */
  const [alongRouteOpen, setAlongRouteOpen] = useState(false);
  /** Optional category to pre-select when the AlongRoutePanel opens.
   *  Set by the parking-on-approach pill so the panel skips the
   *  "pick a chip" step. Cleared whenever the panel closes so the
   *  next manual open starts on the empty state. */
  const [alongRouteInitialCategory, setAlongRouteInitialCategory] =
    useState<NearbyPoiCategory | undefined>(undefined);
  /** Whether the Get-to-safety bottom sheet is open. Always-available
   *  (i.e. not gated on an active trip) because the whole point is to
   *  reach it when something has gone wrong. */
  const [safetyEscapeOpen, setSafetyEscapeOpen] = useState(false);
  /** Per-trip dismissal flag for the "Need parking?" pill. Reset
   *  whenever a new trip starts so the next drive can re-prompt. */
  const [parkingPillDismissed, setParkingPillDismissed] = useState(false);
  const [tripMode, setTripMode] = useState<string | null>(null);
  const [tripSteps, setTripSteps] = useState<ManeuverStep[] | null>(null);
  // Toggles the full step-by-step list overlay. Auto-cleared when the
  // trip ends so it never lingers after navigation finishes.
  const [showTurnList, setShowTurnList] = useState(false);
  useEffect(() => {
    if (!tripGeometry && showTurnList) setShowTurnList(false);
    if (!tripGeometry && alongRouteOpen) setAlongRouteOpen(false);
  }, [tripGeometry, showTurnList, alongRouteOpen]);
  // Keep the screen awake while the user is actively navigating, the
  // same UX Google Maps gives during turn-by-turn. Released
  // automatically when the trip ends. This is best-effort: browsers
  // without the Screen Wake Lock API silently no-op.
  useWakeLock(Boolean(tripGeometry));
  const [previewOrigin, setPreviewOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [previewDest, setPreviewDest] = useState<{ lat: number; lng: number } | null>(null);
  const [previewWaypoints, setPreviewWaypoints] = useState<WaypointPin[] | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showLayers, setShowLayers] = useState(false);
  // Map measurement tool. When `measureMode` is on, every map tap
  // appends a vertex to `measurePoints` and the SafetyScoreCard /
  // dropped-pin codepaths are bypassed.
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<[number, number][]>([]);
  /** Perimeter mode — taps form a polygon; the panel shows incident
   *  count inside. Distinct from measure so they don't fight. */
  const [perimeterMode, setPerimeterMode] = useState(false);
  const [perimeterPoints, setPerimeterPoints] = useState<[number, number][]>([]);
  const [heatmapEnabled, setHeatmapEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    return !window.matchMedia("(max-width: 767px)").matches;
  });
  const [districtsEnabled, setDistrictsEnabled] = useState(false);
  // "This hour's hotspots" overlay — when on, the heatmap weights
  // incidents within ±1h of the current hour-of-day at full strength
  // and gracefully tapers the rest down. Useful with longer time
  // windows (week / month / 5-month) where the hotspots otherwise
  // average across all hours of the day.
  const [todOverlayEnabled, setTodOverlayEnabled] = useState(false);
  const [todHourFocus, setTodHourFocus] = useState<number | null>(null);

  const [feedSortMode, setFeedSortMode] = useState<"recent" | "near">("recent");
  const [feedUserLoc, setFeedUserLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [feedLocating, setFeedLocating] = useState(false);
  const [feedSearchQuery, setFeedSearchQuery] = useState("");
  const [feedVisibleLimit, setFeedVisibleLimit] = useState(40);

  const requestFeedLocation = useCallback(async () => {
    setFeedLocating(true);
    try {
      const pos = await getCurrentPosition();
      setFeedUserLoc({ lat: pos.lat, lng: pos.lng });
      setFeedSortMode("near");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not get your location");
    } finally {
      setFeedLocating(false);
    }
  }, []);

  // Persistent Safety-POI overlay state. Each enabled category triggers
  // a viewport-bbox Overpass fetch; results are de-duplicated across
  // categories and handed to IncidentMap as a single flat list. We
  // gate the fetch on min zoom (≥ 12) since denser zooms would pull
  // hundreds of POIs and obscure incident markers.
  // Render the user's saved places (Home/Work/Favorite/Custom) as
  // map pins. Persisted across reloads so the map state always
  // matches what the user expects from session to session.
  // Live mirror of the parked-pin store so map marker + bottom pill
  // stay in sync with PlaceActions / external sets.
  const [parkedPin, setParkedPinState] = useState<ParkedPin | null>(null);
  useEffect(() => {
    setParkedPinState(getParkedPin());
    return subscribeParkedPin(setParkedPinState);
  }, []);

  const [savedPlacesOverlay, setSavedPlacesOverlay] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("pp:saved-places-overlay") !== "0";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    setPref("pp:saved-places-overlay", savedPlacesOverlay ? "1" : "0");
  }, [savedPlacesOverlay]);

  /** Pinning saved places on the map is Pro-only (wait for auth so we
   *  don't clear the overlay during the initial `isPro === false` tick). */
  useEffect(() => {
    if (authLoading) return;
    if (!isPro) setSavedPlacesOverlay(false);
  }, [isPro, authLoading]);

  // Community voting removed — incidents are driven purely by timestamps.

  const [safetyPoiCats, setSafetyPoiCats] = useState<Set<SafetyPoiCategory>>(() => new Set());
  const [safetyPois, setSafetyPois] = useState<
    Array<{ id: string; name: string; category: SafetyPoiCategory; lat: number; lng: number }>
  >([]);
  const safetyFetchSeqRef = useRef(0);
  const lastSafetyBboxRef = useRef<string>("");

  const toggleSafetyCat = useCallback((id: SafetyPoiCategory) => {
    setSafetyPoiCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Same pattern as safetyPois, but for the convenience overlays
  // (gas, EV, food, ATM, parking, restroom). Persisted across reloads
  // since these are user preference, not session-scoped exploration.
  const [nearbyPoiCats, setNearbyPoiCats] = useState<Set<NearbyPoiCategory>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem("pp:nearby-poi-cats");
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      const valid = new Set(NEARBY_POI_CATEGORIES.map((c) => c.id));
      return new Set(arr.filter((id) => valid.has(id)) as NearbyPoiCategory[]);
    } catch { return new Set(); }
  });
  const [nearbyPois, setNearbyPois] = useState<
    Array<{ id: string; name: string; category: NearbyPoiCategory; lat: number; lng: number }>
  >([]);
  const nearbyFetchSeqRef = useRef(0);
  const lastNearbyBboxRef = useRef<string>("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPref("pp:nearby-poi-cats", JSON.stringify([...nearbyPoiCats]));
  }, [nearbyPoiCats]);

  const toggleNearbyCat = useCallback((id: NearbyPoiCategory) => {
    setNearbyPoiCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Kick off an initial fetch whenever the set of enabled categories
  // changes — otherwise the user has to pan the map before anything
  // appears, which makes the toggle feel broken.
  useEffect(() => {
    if (safetyPoiCats.size === 0) {
      setSafetyPois([]);
      lastSafetyBboxRef.current = "";
      return;
    }
    const bounds = mapRef.current?.getBounds();
    if (!bounds) return;
    const seq = ++safetyFetchSeqRef.current;
    lastSafetyBboxRef.current = ""; // force the next move to also refetch if needed
    void (async () => {
      const enabled = [...safetyPoiCats];
      const results = await Promise.all(
        enabled.map((cat) => fetchPoisInBounds(cat, bounds, 60))
      );
      if (seq !== safetyFetchSeqRef.current) return;
      setSafetyPois(
        results.flat().map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category as SafetyPoiCategory,
          lat: p.lat,
          lng: p.lng,
        }))
      );
    })();
  }, [safetyPoiCats]);

  // Mirror of the safety-POI initial fetch for convenience POIs.
  useEffect(() => {
    if (nearbyPoiCats.size === 0) {
      setNearbyPois([]);
      lastNearbyBboxRef.current = "";
      return;
    }
    const bounds = mapRef.current?.getBounds();
    if (!bounds) return;
    const seq = ++nearbyFetchSeqRef.current;
    lastNearbyBboxRef.current = "";
    void (async () => {
      const enabled = [...nearbyPoiCats];
      const results = await Promise.all(
        // Slightly higher limit per category — gas/food/coffee tend to
        // be denser than hospitals.
        enabled.map((cat) => fetchPoisInBounds(cat, bounds, 80))
      );
      if (seq !== nearbyFetchSeqRef.current) return;
      setNearbyPois(
        results.flat().map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category as NearbyPoiCategory,
          lat: p.lat,
          lng: p.lng,
        }))
      );
    })();
  }, [nearbyPoiCats]);
  useEffect(() => {
    if (!todOverlayEnabled) {
      setTodHourFocus(null);
      return;
    }
    setTodHourFocus(new Date().getHours());
    // Re-anchor every 5 minutes so the focus tracks across hour
    // boundaries without per-render thrash.
    const t = setInterval(() => setTodHourFocus(new Date().getHours()), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [todOverlayEnabled]);
  const [basemapStyle, setBasemapStyle] = useState<BasemapStyle>(() => {
    if (typeof window === "undefined") return "auto";
    const saved = localStorage.getItem("pp:basemap");
    if (saved === "auto" || saved === "dark" || saved === "voyager" || saved === "positron" || saved === "streets") {
      return saved;
    }
    return "auto";
  });
  useEffect(() => {
    if (typeof window !== "undefined") setPref("pp:basemap", basemapStyle);
  }, [basemapStyle]);
  const [vectorTilesEnabled, setVectorTilesEnabled] = useVectorTiles();
  const [showInbox, setShowInbox] = useState(false);
  // Which AlertsInbox sub-panel should be visible when it opens. Set
  // by the bottom-nav URL hint (`?inbox=settings` → "settings"); the
  // user can still toggle internally once the drawer is up.
  const [inboxPanel, setInboxPanel] = useState<"list" | "settings">("list");
  // The query-param sync itself is rendered as a tiny child below
  // (`<InboxUrlSync />`) — `useSearchParams` requires a Suspense
  // boundary and we keep it scoped to a leaf component instead of
  // pulling the entire MapHome under <Suspense>.
  const handleInboxUrlChange = useCallback((panel: InboxPanel) => {
    if (panel === "settings") {
      setInboxPanel("settings");
      setShowInbox(true);
    } else if (panel === "list") {
      setInboxPanel("list");
      setShowInbox(true);
    }
    // panel === null → don't auto-close; the user might have opened
    // the drawer themselves and there's no `?inbox=` to honor.
  }, []);
  // Tracked separately from the inbox panel itself so the bell badge
  // updates even while the panel is closed (e.g. an alert lands while
  // the user is mid-trip).
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  useEffect(() => {
    const initial = unreadCount();
    setUnreadAlerts(initial);
    setAppBadge(initial);
    const unsub = subscribeAlerts((next) => {
      const n = next.reduce((acc, a) => acc + (a.read ? 0 : 1), 0);
      setUnreadAlerts(n);
      // Mirror the unread bell count to the OS app icon for installed
      // PWAs (Chrome/Edge desktop, iOS 16.4+ Safari home-screen). No-op
      // in regular browser tabs — the in-app bell is the only surface
      // there.
      setAppBadge(n);
    });
    return unsub;
  }, []);
  const [tripProgress, setTripProgress] = useState(0);
  const [gpsStatus, setGpsStatus] = useState<"idle" | "loading" | "found" | "denied">("idle");
  // Recap card shown when a trip ends — populated from `tripStatsRef`
  // captured at trip start (since SearchSidebar's local routeInfo is
  // gone by the time the callback fires `active=false`).
  const [tripRecap, setTripRecap] = useState<TripRecap | null>(null);
  // Pinned to the latest recorded trip-history entry id, so the recap
  // card can patch it with rating/notes inline rather than re-recording.
  const [tripRecapHistoryId, setTripRecapHistoryId] = useState<string | null>(null);
  const tripStatsRef = useRef<{
    startedAt: number;
    totalDistanceKm: number;
    mode: string;
    nearbyIncidents: number;
    wasSafeRoute: boolean;
    origin?: { display_name: string; lat: number; lng: number };
    dest?: { display_name: string; lat: number; lng: number };
    /** Decimated geometry kept on the trip so we can stash it into
     *  trip-history at completion for GPX export. We snapshot at
     *  start (geometry doesn't drift mid-trip — reroutes blow away
     *  the trip and start a new one) and decimate to ~120 vertices
     *  to stay under localStorage budget. */
    geometry?: [number, number][];
  } | null>(null);
  const lastTripProgressRef = useRef(0);
  useEffect(() => { lastTripProgressRef.current = tripProgress; }, [tripProgress]);

  // Live speed readout — only watched while driving / cycling so we
  // don't burn battery on the search screen.
  const speedTracked = Boolean(tripGeometry && (tripMode === "driving-car" || tripMode === "cycling-regular"));
  const { mps: tripSpeedMps } = useGpsSpeed(speedTracked);

  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 768;
  });
  const [selectedDistrict, setSelectedDistrict] = useState<{ district: District; incidents: Incident[] } | null>(null);
  const [clusterIncidentIds, setClusterIncidentIds] = useState<string[] | null>(null);
  const [showUpgrade, setShowUpgrade] = useState<string | null>(null);
  // Listen for upgrade requests dispatched by descendants (saved-place
  // limit, commute toggle, etc.). Centralizing the modal here avoids
  // mounting one per gated surface and keeps focus management simple.
  useEffect(() => onUpgradeRequested((feature) => setShowUpgrade(feature)), []);
  const [feedLabels, setFeedLabels] = useState<Record<string, string>>(DEFAULT_FEED_LABELS);
  const mapRef = useRef<MapHandle>(null);

  useEffect(() => {
    function onOpenAsk() {
      if (!isPro) {
        setShowUpgrade("Ask Pulse");
        return;
      }
      setViewTab("ask");
    }
    window.addEventListener("pp:open-ask", onOpenAsk);
    return () => window.removeEventListener("pp:open-ask", onOpenAsk);
  }, [isPro]);

  // When PlaceActions in any card requests directions, ensure the sidebar
  // is visible (mobile auto-collapses) and dismiss the lightweight overlays.
  useEffect(() => {
    function handler() {
      setViewTab("map");
      setSidebarOpen(true);
      setMapTap(null);
    }
    window.addEventListener("pp:plan-route", handler);
    return () => window.removeEventListener("pp:plan-route", handler);
  }, []);

  // Click-throughs from the AnalyticsPanel: jump back to the map and focus the
  // selected scope. Kept event-driven so the panel never needs a callback ref
  // into MapHome (which would force a re-mount on every analytics interaction).
  useEffect(() => {
    function onScope(ev: Event) {
      const detail = (ev as CustomEvent).detail as
        | { kind: "district"; slug: string }
        | { kind: "neighborhood"; slug: string }
        | { kind: "point"; lat: number; lng: number }
        | undefined;
      if (!detail) return;
      setViewTab("map");
      if (detail.kind === "district") {
        const district = getDistrictBySlug(detail.slug);
        if (!district) return;
        const incs = incidentsInDistrict(incidents, detail.slug);
        setSelectedDistrict({ district, incidents: incs });
        requestAnimationFrame(() =>
          mapRef.current?.flyTo(district.center.lat, district.center.lng, 13)
        );
      } else if (detail.kind === "neighborhood") {
        const n = getNeighborhoodBySlug(detail.slug);
        if (!n) return;
        requestAnimationFrame(() =>
          mapRef.current?.flyTo(n.center.lat, n.center.lng, 14)
        );
      } else if (detail.kind === "point") {
        setMapTap({ lat: detail.lat, lng: detail.lng });
        requestAnimationFrame(() =>
          mapRef.current?.flyTo(detail.lat, detail.lng, 16)
        );
      }
    }
    window.addEventListener("pp:analytics-scope", onScope);
    return () => window.removeEventListener("pp:analytics-scope", onScope);
  }, [incidents]);

  // Native (Android) hardware back-button: pop the topmost overlay before
  // letting Capacitor exit the app. Calling preventDefault() consumes the
  // event so the host shell stays alive. No-op on web.
  useEffect(() => {
    function onBack(ev: Event) {
      if (safetyEscapeOpen)       { setSafetyEscapeOpen(false);  ev.preventDefault(); return; }
      if (selectedId)             { setSelectedId(null);         ev.preventDefault(); return; }
      if (clusterIncidentIds)     { setClusterIncidentIds(null); ev.preventDefault(); return; }
      if (selectedDistrict)       { setSelectedDistrict(null);   ev.preventDefault(); return; }
      if (peekAnchor)             { setPeekAnchor(null);         ev.preventDefault(); return; }
      if (mapTap)                 { setMapTap(null);             ev.preventDefault(); return; }
      if (showInbox)              { setShowInbox(false);         ev.preventDefault(); return; }
      if (showAbout)              { setShowAbout(false);         ev.preventDefault(); return; }
    }
    window.addEventListener("pp:native-back", onBack);
    return () => window.removeEventListener("pp:native-back", onBack);
  }, [selectedId, clusterIncidentIds, selectedDistrict, mapTap, showAbout, showInbox, safetyEscapeOpen, peekAnchor]);

  // Auto-dismiss the long-press peek when any competing bottom-left
  // overlay opens. Cheap effect — runs once per state transition.
  useEffect(() => {
    if (!peekAnchor) return;
    if (selectedId || clusterIncidentIds || selectedDistrict || mapTap) {
      setPeekAnchor(null);
    }
  }, [peekAnchor, selectedId, clusterIncidentIds, selectedDistrict, mapTap]);

  /** Deep-link bootstrap (read once on mount):
   *   ?incident=<id>            → select that incident when it arrives in the feed
   *   ?lat=&lng=&zoom=16        → drop a SafetyScoreCard at that point + fly to it
   *   #zoom/lat/lng (handled by IncidentMap) → set initial map view
   * After applying we strip the query string so a refresh doesn't re-trigger. */
  const pendingDeepIncidentRef = useRef<string | null>(null);
  const [sharedTrip, setSharedTrip] = useState<DecodedTripToken | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const incidentParam = params.get("incident");
    const latParam = params.get("lat");
    const lngParam = params.get("lng");
    const zoomParam = params.get("zoom");
    const tripParam = params.get("trip");
    const sourceParam = params.get("source");

    // PWA app-shortcut entries land here as ?source=shortcut-* . Each
    // dispatches a UI intent the corresponding component listens for,
    // mirroring the in-app pattern (`pp:focus-search`, etc.) so we
    // don't need direct setter access.
    if (sourceParam?.startsWith("shortcut-")) {
      const intent = sourceParam.replace("shortcut-", "");
      // Defer one frame so subscribers have time to mount.
      requestAnimationFrame(() => {
        switch (intent) {
          case "safety":
            window.dispatchEvent(new CustomEvent("pp:locate-and-score"));
            break;
          case "directions":
            window.dispatchEvent(new CustomEvent("pp:focus-search"));
            break;
          case "saved":
            window.dispatchEvent(new CustomEvent("pp:open-saved-places"));
            break;
          case "inbox":
            window.dispatchEvent(new CustomEvent("pp:open-inbox"));
            break;
          case "parked":
            window.dispatchEvent(new CustomEvent("pp:goto-parked"));
            break;
        }
      });
    }

    if (tripParam) {
      // ?trip=<token> → recipient view of a "Share my live ETA" link. The
      // token is fully self-contained — no backend roundtrip needed.
      const decoded = decodeTripToken(tripParam);
      if (decoded) setSharedTrip(decoded);
    }

    if (incidentParam) {
      pendingDeepIncidentRef.current = incidentParam;
    } else if (latParam && lngParam) {
      const lat = parseFloat(latParam);
      const lng = parseFloat(lngParam);
      const zoom = zoomParam ? parseInt(zoomParam, 10) : 16;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        setMapTap({ lat, lng });
        // Defer flyTo until the map has mounted (next frame is enough).
        requestAnimationFrame(() => {
          mapRef.current?.flyTo(lat, lng, Number.isFinite(zoom) ? zoom : 16);
        });
      }
    }

    if (incidentParam || latParam || lngParam || zoomParam || tripParam || sourceParam) {
      const cleaned = new URL(window.location.href);
      ["incident", "lat", "lng", "zoom", "trip", "source"].forEach((k) => cleaned.searchParams.delete(k));
      window.history.replaceState({}, "", cleaned.toString());
    }
  }, []);

  // Apply ?incident=<id> once the feed has the matching record.
  useEffect(() => {
    const id = pendingDeepIncidentRef.current;
    if (!id || incidents.length === 0) return;
    const found = incidents.find((i) => i.id === id);
    if (!found) return;
    pendingDeepIncidentRef.current = null;
    setSelectedId(id);
    if (found.lat != null && found.lng != null) {
      requestAnimationFrame(() => {
        mapRef.current?.flyTo(found.lat!, found.lng!, 16);
      });
    }
  }, [incidents]);

  useEffect(() => {
    const slug = getCurrentCity().slug;
    const q = slug ? `?city=${encodeURIComponent(slug)}` : "";
    fetchPublicApi(`/api/admin/feeds${q}`)
      .then(async (r) => {
        if (!r.ok) return;
        const data = (await r.json()) as { feeds?: { feed_id?: string; label?: string }[] };
        if (data.feeds && Array.isArray(data.feeds)) {
          const labels: Record<string, string> = {};
          for (const f of data.feeds) {
            if (f.feed_id && f.label) labels[f.feed_id] = f.label;
          }
          if (Object.keys(labels).length > 0) setFeedLabels(labels);
        }
      })
      .catch(() => {});
  }, []);

  const goToMyLocation = useCallback(() => {
    if (userLocation) {
      mapRef.current?.flyTo(userLocation.lat, userLocation.lng, 15);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(loc);
        mapRef.current?.flyTo(loc.lat, loc.lng, 15);
      },
      () => {
        /* user denied or unavailable */
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }, [userLocation]);

  const recenterCity = useCallback(() => {
    mapRef.current?.resetView();
  }, []);

  // PWA app-shortcut intents — fired once on mount from the deep-link
  // bootstrap above when the user enters via a launcher shortcut. Each
  // listener just translates the intent into the same in-app action a
  // tap would have produced.
  useEffect(() => {
    const onLocateAndScore = () => {
      // If we already have a fix, drop a SafetyScoreCard at the user's
      // location. Otherwise, ask the browser for a one-shot fix and
      // wait — same UX as tapping "My location" then long-pressing.
      const apply = (lat: number, lng: number) => {
        setMapTap({ lat, lng });
        requestAnimationFrame(() => mapRef.current?.flyTo(lat, lng, 16));
      };
      if (userLocation) {
        apply(userLocation.lat, userLocation.lng);
        return;
      }
      if (typeof navigator === "undefined" || !navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => apply(pos.coords.latitude, pos.coords.longitude),
        () => { /* user denied; nothing else to do */ },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      );
    };
    const onOpenInbox = () => setShowInbox(true);
    const onOpenSavedPlaces = () => {
      // SavedPlaces lives inside the search sidebar. Focusing the
      // search box is the cheapest way to ensure the sidebar is
      // visible and scrolled to where SavedPlaces will mount.
      window.dispatchEvent(new CustomEvent("pp:focus-search"));
    };
    const onGotoParked = () => {
      // Re-import lazily so the page bundle doesn't get bloated by
      // pulling parked-pin storage into the initial chunk just for
      // an app-shortcut path most users won't take.
      void import("@/lib/parked-pin").then(({ getParkedPin }) => {
        const pin = getParkedPin();
        if (!pin) return;
        // Fire the same plan-route event the ParkedPinPill uses for
        // its "Walk back" button — keeps a single code path for "find
        // my parked car".
        window.dispatchEvent(
          new CustomEvent("pp:plan-route", {
            detail: {
              mode: "to",
              lat: pin.lat,
              lng: pin.lng,
              label: pin.label || "Parked here",
              transport: "foot-walking",
            },
          })
        );
        requestAnimationFrame(() => mapRef.current?.flyTo(pin.lat, pin.lng, 17));
      });
    };
    window.addEventListener("pp:locate-and-score", onLocateAndScore);
    window.addEventListener("pp:open-inbox", onOpenInbox);
    window.addEventListener("pp:open-saved-places", onOpenSavedPlaces);
    window.addEventListener("pp:goto-parked", onGotoParked);
    return () => {
      window.removeEventListener("pp:locate-and-score", onLocateAndScore);
      window.removeEventListener("pp:open-inbox", onOpenInbox);
      window.removeEventListener("pp:open-saved-places", onOpenSavedPlaces);
      window.removeEventListener("pp:goto-parked", onGotoParked);
    };
  }, [userLocation]);

  // Global keyboard shortcuts. The `?` key (handled inside
  // KeyboardShortcutsHelp) opens the cheat sheet — every other binding
  // lives here so it has access to the page-level state setters.
  // We intentionally bail out when typing in any input/contenteditable
  // so single-letter shortcuts (b/m/n/s/l/f) don't hijack normal input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      // Modifier-bearing combos: only Cmd/Ctrl+K is meaningful here.
      // Everything else with a modifier we let through to the browser.
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "k") {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("pp:focus-search"));
        }
        return;
      }
      // Plain key shortcuts — single character, no modifiers.
      switch (e.key) {
        case "/":
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("pp:focus-search"));
          break;
        case "l": case "L":
          e.preventDefault();
          recenterCity();
          break;
        case "f": case "F":
          e.preventDefault();
          setFollowMe((v) => !v);
          break;
        case "b": case "B": {
          e.preventDefault();
          // Cycle through the same order the Layers menu lists them.
          const order: BasemapStyle[] = ["auto", "voyager", "positron", "dark", "streets"];
          const idx = order.indexOf(basemapStyle);
          const next = order[(idx + 1) % order.length];
          setBasemapStyle(next);
          break;
        }
        case "m": case "M":
          e.preventDefault();
          setShowLayers((v) => !v);
          break;
        case "s": case "S":
          e.preventDefault();
          setSavedPlacesOverlay((v) => !v);
          break;
        case "n": case "N":
          // Cycle nearby-POI overlay: off → fuel/food/coffee minimal set
          // → off. Keeping the toggle binary-ish avoids needing a
          // category picker for keyboard users.
          e.preventDefault();
          setNearbyPoiCats((prev) => {
            if (prev.size > 0) return new Set();
            return new Set<NearbyPoiCategory>(["fuel", "food", "coffee"]);
          });
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [basemapStyle, recenterCity]);

  const loadFromApi = useCallback(async () => {
    if (useFirestoreData) {
      // Firestore listener + snapshot own `incidents`. A parallel REST pull
      // that calls `setIncidents` can wipe pins when the Python API returns
      // 200 with an empty list, errors, or races behind Firestore — and
      // 502 retries to api.phlpulse.com hit nginx error pages without CORS,
      // surfacing as misleading "CORS" noise while the map goes blank.
      const [sr, tr] = await Promise.allSettled([fetchSummary(), fetchStats()]);
      if (sr.status === "fulfilled") {
        setSummary(sr.value.summary);
      } else {
        const cur = incidentsForStatsRef.current;
        if (cur.length) setSummary(buildLocalSummary(cur));
      }
      if (tr.status === "fulfilled") {
        setStats(tr.value);
      } else {
        const cur = incidentsForStatsRef.current;
        if (cur.length) setStats(statsFromIncidents(cur));
      }
      return;
    }

    // API-only mode: pins + summary/stats all come from the backend.
    const incPromise = fetchIncidents()
      .then((rows) => {
        setIncidents(rows);
        return rows;
      })
      .catch((reason) => {
        console.error("Failed to load incidents:", reason);
        return null;
      });

    const [sr, tr] = await Promise.allSettled([fetchSummary(), fetchStats()]);
    const inc = await incPromise;

    if (sr.status === "fulfilled") {
      setSummary(sr.value.summary);
    } else if (inc) {
      setSummary(buildLocalSummary(inc));
    }
    if (tr.status === "fulfilled") {
      setStats(tr.value);
    } else if (inc) {
      setStats(statsFromIncidents(inc));
    }
  }, [useFirestoreData]);

  useEffect(() => {
    if (!useFirestoreData || statsAfterFirestoreRef.current) return;
    if (incidents.length === 0) return;
    statsAfterFirestoreRef.current = true;
    void loadFromApi();
  }, [useFirestoreData, incidents.length, loadFromApi]);

  useEffect(() => {
    const cached = loadCachedIncidents(getCurrentCity().slug);
    if (cached && cached.incidents.length > 0) {
      setSummary(buildLocalSummary(cached.incidents));
      setStats(statsFromIncidents(cached.incidents));
    }
  }, []);

  useEffect(() => {
    if (useFirestoreData) {
      // Initial pins come from localStorage (see ``useState`` above) and the
      // first ``onSnapshot`` tick. Avoid a duplicate full-query ``getDocs`` —
      // it billed the same ~MAP_SYNC_LIMIT document reads twice per cold load.
      void loadFromApi();
      const unsub = subscribeIncidents(
        (next) => setIncidents(next),
        (e) => {
          console.error("Firestore incidents:", e);
          // Missing/building composite index or other precondition: do NOT
          // flip to API-only — BACKEND may be 502 and we'd paint an empty map.
          const code = (e as { code?: string }).code;
          if (code === "failed-precondition") {
            return;
          }
          // Bad key, permission, etc.: fall back to REST polling.
          setFirestoreAvailable(false);
        }
      );
      return unsub;
    }
    void loadFromApi();
    const timer = setInterval(loadFromApi, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [useFirestoreData, loadFromApi]);

  useEffect(() => {
    const id = setInterval(() => {
      setIncidents((prev) => enrichIncidents(prev));
    }, WEIGHT_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  /** Seed `mapBounds` once the map handle is ready. Without this the
   *  viewport-scoped badge stays unscoped until the user pans/zooms,
   *  which would make the initial counter look "wrong" (whole city
   *  instead of what's on screen). Polls briefly because `getBounds()`
   *  returns null before MapLibre/Leaflet has measured the container. */
  useEffect(() => {
    if (mapBounds) return;
    let stopped = false;
    let tries = 0;
    const id = window.setInterval(() => {
      if (stopped) return;
      tries++;
      const b = mapRef.current?.getBounds();
      if (b) {
        setMapBounds(b);
        stopped = true;
        window.clearInterval(id);
      } else if (tries > 25) {
        // ~5s with no map ready — give up; the next move event will
        // seed bounds eventually.
        stopped = true;
        window.clearInterval(id);
      }
    }, 200);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [mapBounds]);

  /** When the selected chip is wider than the live listener window, page
   *  through Firestore until the whole timeframe is loaded (or the user
   *  changes chips). Sub-hour chips rely on the listener only. */
  useEffect(() => {
    if (!useFirestoreData) {
      setExtendedIncidents([]);
      setExtendedTotal(null);
      setExtendedLoading(false);
      return;
    }
    if (!timeFilterNeedsExtendedFetch(timeFilter)) {
      setExtendedIncidents([]);
      setExtendedTotal(null);
      setExtendedLoading(false);
      return;
    }

    let cancelled = false;
    const sinceISO = sinceIsoForTimeFilterHours(timeFilter);

    setExtendedIncidents([]);
    setExtendedTotal(null);
    setExtendedLoading(true);

    // Cheap accurate total via the CDN-cached count endpoint — typically
    // 0 Firestore reads per visitor when the cache is warm.
    fetchIncidentCount({ hours: timeFilter })
      .then((total) => {
        if (!cancelled) setExtendedTotal(total);
      })
      .catch((e) => {
        console.warn("Incident count fetch failed", e);
        if (!cancelled) setExtendedTotal(-1);
      });

    // Stream pages until exhausted or cancelled. We append to state
    // each page so the user can start interacting with partial data.
    (async () => {
      let cursor: string | null = null;
      try {
        do {
          const { rows, nextCursor } = await fetchExtendedHistoryPage({
            sinceISO,
            cursor,
            pageSize: EXTENDED_HISTORY_PAGE_SIZE,
          });
          if (cancelled) return;
          if (rows.length > 0) {
            setExtendedIncidents((prev) => prev.concat(rows));
          }
          cursor = nextCursor;
        } while (cursor && !cancelled);
      } catch (e) {
        console.warn("Extended history paged fetch failed", e);
      } finally {
        if (!cancelled) setExtendedLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [timeFilter, useFirestoreData]);

  // Off-screen incident detection. The first time we receive an incident
  // batch we silently seed `seenIncidentIdsRef` so the user isn't bombed
  // with chips for already-loaded data; after that, any newly-arrived
  // high-severity incident outside the current viewport gets surfaced.
  useEffect(() => {
    if (incidents.length === 0) return;
    if (!seenInitialisedRef.current) {
      for (const inc of incidents) seenIncidentIdsRef.current.add(inc.id);
      seenInitialisedRef.current = true;
      return;
    }
    if (offscreenAlert) return; // one alert at a time

    const bounds = mapRef.current?.getBounds();
    const center = mapRef.current?.getCenter();
    if (!bounds || !center) return;

    // Find the highest-severity *new* incident we haven't dismissed.
    // Categories the user has muted are skipped at the source — they
    // shouldn't show as a chip *or* in the inbox.
    const muted = loadMutedCategories();
    let best: { inc: Incident; w: number } | null = null;
    for (const inc of incidents) {
      if (seenIncidentIdsRef.current.has(inc.id)) continue;
      seenIncidentIdsRef.current.add(inc.id);
      if (dismissedAlertIdsRef.current.has(inc.id)) continue;
      if (inc.lat == null || inc.lng == null) continue;
      if (muted.has(inc.severity_category)) continue;
      const w = inc.w_eff ?? 0.5;
      if (w < 0.55) continue; // only meaningful severity
      const inView =
        inc.lat <= bounds.north &&
        inc.lat >= bounds.south &&
        inc.lng <= bounds.east &&
        inc.lng >= bounds.west;
      if (inView) continue;
      if (!best || w > best.w) best = { inc, w };
    }
    if (!best) return;

    // Compass bearing from the current map center toward the incident.
    const lat1 = (center.lat * Math.PI) / 180;
    const lat2 = (best.inc.lat! * Math.PI) / 180;
    const dLng = ((best.inc.lng! - center.lng) * Math.PI) / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const bearingDeg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

    setOffscreenAlert({ incident: best.inc, bearingDeg });

    // Persist to the bell-icon inbox so users can scroll back through
    // alerts they may have missed. Same severity threshold (`w >= 0.55`)
    // means inbox stays in sync with what the chip surfaces.
    {
      const inc = best.inc;
      const sev = getSeverity(inc.severity_category);
      if (inc.lat != null && inc.lng != null) {
        recordAlert({
          id: `offscreen-${inc.id}`,
          incidentId: inc.id,
          kind: "offscreen",
          title: `${sev.label} reported nearby`,
          body: inc.location_text || "Off-screen incident",
          category: inc.severity_category,
          lat: inc.lat,
          lng: inc.lng,
        });
      }
    }

    // If the page isn't visible (user has switched tabs / locked phone),
    // also fire a Web Notification so they don't miss the alert. Same
    // severity threshold (`w >= 0.55`) so chip + notification stay in
    // sync. The notification is a no-op when the tab is foregrounded
    // or the user has denied permission, so it's safe to call always.
    void (async () => {
      const inc = best.inc;
      const sev = getSeverity(inc.severity_category);
      await notifyIfBackgrounded({
        title: `${sev.label} reported nearby`,
        body: inc.location_text || "Tap to view on the map",
        tag: `pp-incident-${inc.id}`,
        onClick: () => {
          if (inc.lat != null && inc.lng != null) {
            mapRef.current?.flyTo(inc.lat, inc.lng, 16);
          }
          setSelectedId(inc.id);
        },
      });
    })();
  }, [incidents, offscreenAlert]);

  // Incident-ahead-on-route detection: while a trip is active, scan
  // every incident for high-severity ones whose closest point on the
  // trip polyline is (a) within ~75 m of the route, and (b) further
  // along the route than where the user currently is. Pick the
  // *nearest* such incident — same metric Maps uses for its "Crash
  // ahead" callouts. Re-runs on either incident updates or user move
  // (debounced via the dependency array). Dismissed IDs persist for
  // the trip lifetime via `aheadDismissedRef`.
  const aheadDismissedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!tripGeometry) {
      aheadDismissedRef.current.clear();
      setAheadAlert(null);
    }
  }, [tripGeometry]);
  const [aheadAlert, setAheadAlert] = useState<{ incident: Incident; distanceM: number } | null>(null);
  useEffect(() => {
    if (!tripGeometry || !userLocation) {
      if (aheadAlert) setAheadAlert(null);
      return;
    }
    const userProj = distanceAlongRoute(
      [userLocation.lat, userLocation.lng],
      tripGeometry
    );
    if (!userProj) return;

    const mutedAhead = loadMutedCategories();
    let best: { inc: Incident; distM: number } | null = null;
    for (const inc of incidents) {
      if (inc.lat == null || inc.lng == null) continue;
      if (aheadDismissedRef.current.has(inc.id)) continue;
      if (mutedAhead.has(inc.severity_category)) continue;
      const w = inc.w_eff ?? 0.5;
      if (w < 0.55) continue; // mirror off-screen-chip threshold
      const proj = distanceAlongRoute([inc.lat, inc.lng], tripGeometry);
      if (!proj) continue;
      if (proj.offsetM > 75) continue; // must be on/very-near route
      const ahead = proj.alongM - userProj.alongM;
      if (ahead < 30) continue;       // already passed (or under us)
      if (ahead > 1500) continue;     // out of "soon" range
      if (!best || ahead < best.distM) best = { inc, distM: ahead };
    }
    setAheadAlert(best ? { incident: best.inc, distanceM: best.distM } : null);
    if (best && best.inc.lat != null && best.inc.lng != null) {
      const sev = getSeverity(best.inc.severity_category);
      recordAlert({
        id: `ahead-${best.inc.id}`,
        incidentId: best.inc.id,
        kind: "ahead",
        title: `${sev.label} ahead on route`,
        body: best.inc.location_text || `In ${Math.round(best.distM)} m`,
        category: best.inc.severity_category,
        lat: best.inc.lat,
        lng: best.inc.lng,
      });
      // Spoken cue. Dedupe on the incident ID so a slow re-render
      // loop doesn't repeatedly announce the same one. The voice-nav
      // queue handles the global mute pref + priority pre-emption.
      void import("@/lib/voice-nav").then(({ speakNav, speakableDistance }) => {
        speakNav(
          `Caution. ${sev.label} reported ${speakableDistance(best!.distM)} ahead.`,
          {
            priority: "alert",
            dedupeKey: `ahead-${best!.inc.id}`,
            dedupeMs: 2 * 60_000,
          }
        );
      });
    }
  }, [tripGeometry, userLocation, incidents, aheadAlert]);

  // API-backed summary + stats poll. Self-degrades when the Python
  // backend is unreachable: after the first failure we stop polling
  // and let the Firestore-derived effect below take over, so a hung
  // /api/summary endpoint doesn't spam the console with a failure
  // every POLL_INTERVAL ms forever.
  const [apiSummaryDown, setApiSummaryDown] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (apiSummaryDown) return;
    let cancelled = false;
    let consecutiveFailures = 0;
    const pull = async () => {
      try {
        const [sum, st] = await Promise.all([fetchSummary(), fetchStats()]);
        if (!cancelled) {
          setSummary(sum.summary);
          setStats(st);
          consecutiveFailures = 0;
        }
      } catch (e) {
        consecutiveFailures += 1;
        // Log once on the first failure, then stop polling. The
        // Firestore-derived fallback effect below will take it from
        // here so the UI keeps showing fresh stats from local data.
        if (consecutiveFailures === 1) {
          console.warn("[summary/stats] API unavailable, falling back to client-derived stats", e);
        }
        if (consecutiveFailures >= 2 && !cancelled) {
          setApiSummaryDown(true);
        }
      }
    };
    void pull();
    const t = setInterval(pull, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(t); };
  }, [apiSummaryDown]);

  useEffect(() => {
    // When the API summary/stats poll has given up, derive both from the
    // incident list (Firestore *or* REST — same shape) so the sidebar does
    // not stay blank on REST-only deployments.
    if (!apiSummaryDown) return;
    setSummary(buildLocalSummary(incidents));
    setStats(statsFromIncidents(incidents));
  }, [incidents, apiSummaryDown]);

  const toggleCat = useCallback((cats: readonly string[]) => {
    setActiveCats((prev) => toggleCategoryGroupSelection(cats, prev));
  }, []);

  /** Live + extended history merged, deduped by id. Extended is empty
   *  for short time-filter windows so this is identity-cheap on the hot
   *  path. */
  const allIncidents = useMemo(() => {
    if (extendedIncidents.length === 0) return incidents;
    const seen = new Set<string>();
    const merged: Incident[] = [];
    for (const inc of incidents) {
      if (seen.has(inc.id)) continue;
      seen.add(inc.id);
      merged.push(inc);
    }
    for (const inc of extendedIncidents) {
      if (seen.has(inc.id)) continue;
      seen.add(inc.id);
      merged.push(inc);
    }
    return merged;
  }, [incidents, extendedIncidents]);

  const filteredIncidents = allIncidents.filter((inc) => {
    if (inc.hidden) return false;
    const cutoff = Date.now() - timeFilter * 60 * 60 * 1000;
    if (new Date(inc.reported_at).getTime() < cutoff) return false;
    if (activeCats.size > 0 && !activeCats.has(inc.severity_category)) return false;
    return true;
  });

  const feedIncidents = useMemo(() => {
    if (!feedSearchQuery.trim()) return filteredIncidents;
    const q = feedSearchQuery.toLowerCase();
    return filteredIncidents.filter(inc => {
      const text = `${inc.raw_text || ""} ${inc.description || ""} ${inc.location_text || ""}`.toLowerCase();
      return text.includes(q);
    });
  }, [filteredIncidents, feedSearchQuery]);

  const visibleFeedIncidents = useMemo(
    () => feedIncidents.slice(0, feedVisibleLimit),
    [feedIncidents, feedVisibleLimit]
  );

  const feedActiveNow = useMemo(() => activeNowCount(feedIncidents, 30), [feedIncidents]);

  /** Subset of `filteredIncidents` whose pin sits inside the current
   *  map viewport. Drives the badge numerator so the on-screen count
   *  matches what the user can actually see. Falls back to the full
   *  city-wide set when bounds haven't been measured yet. */
  const visibleIncidents = useMemo(() => {
    if (!mapBounds) return filteredIncidents;
    const { north, south, east, west } = mapBounds;
    return filteredIncidents.filter((inc) => {
      if (inc.lat == null || inc.lng == null) return false;
      return (
        inc.lat >= south &&
        inc.lat <= north &&
        inc.lng >= west &&
        inc.lng <= east
      );
    });
  }, [filteredIncidents, mapBounds]);

  const selected = filteredIncidents.find((i) => i.id === selectedId) || null;

  const clusterIncidents = useMemo(() => {
    if (!clusterIncidentIds) return null;
    const idSet = new Set(clusterIncidentIds);
    return filteredIncidents.filter((i) => idSet.has(i.id));
  }, [clusterIncidentIds, filteredIncidents]);

  const activeTimeLabel = (() => {
    const tf = TIME_FILTERS.find((t) => t.hours === timeFilter);
    if (!tf) return "";
    if (!Number.isFinite(tf.hours)) return "All time";
    return `Last ${tf.label}`;
  })();

  const trendPct = useMemo(() => {
    // "All time" has no comparable previous window — short-circuit so
    // the badge doesn't show a meaningless 100% delta.
    if (!Number.isFinite(timeFilter)) return 0;
    const windowMs = timeFilter * 60 * 60 * 1000;
    const now = Date.now();
    const currentStart = now - windowMs;
    const prevStart = currentStart - windowMs;
    const current = incidents.filter((i) => {
      if (i.hidden) return false;
      const t = new Date(i.reported_at).getTime();
      return t >= currentStart;
    }).length;
    const prev = incidents.filter((i) => {
      if (i.hidden) return false;
      const t = new Date(i.reported_at).getTime();
      return t >= prevStart && t < currentStart;
    }).length;
    if (prev === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - prev) / prev) * 100);
  }, [incidents, timeFilter]);

  const hotNeighborhoods = useMemo(() => {
    return NEIGHBORHOODS.map((n) => ({
      name: n.name,
      slug: n.slug,
      count: incidentsInNeighborhood(filteredIncidents, n.slug).length,
    }))
      .filter((n) => n.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [filteredIncidents]);

  const categoryBreakdown = useMemo(() => {
    return CATEGORY_PILLS.map((pill) => ({
      label: pill.label,
      color: pill.color,
      cats: pill.cats,
      count: filteredIncidents.filter((i) => (pill.cats as readonly string[]).includes(i.severity_category)).length,
    })).filter((c) => c.count > 0);
  }, [filteredIncidents]);

  const hourlyData = useMemo(() => {
    const bins = new Array(24).fill(0);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    for (const inc of filteredIncidents) {
      const d = new Date(inc.reported_at);
      if (d.getTime() >= todayStart.getTime()) {
        bins[d.getHours()]++;
      }
    }
    return bins;
  }, [filteredIncidents]);

  const activeFeeds = useMemo(() => {
    const feedCounts = new Map<string, number>();
    for (const inc of filteredIncidents) {
      if (inc.feed_id) {
        feedCounts.set(inc.feed_id, (feedCounts.get(inc.feed_id) ?? 0) + 1);
      }
    }
    return Array.from(feedCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, label: feedLabels[id] || id, count }));
  }, [filteredIncidents, feedLabels]);

  const analyticsAreaName = mapTap
    ? getNeighborhood(mapTap.lat, mapTap.lng)?.name
    : undefined;

  const analyticsAreaIncidents = mapTap
    ? (() => {
        const result = assessSafety(
          { display_name: "", lat: mapTap.lat, lng: mapTap.lng },
          filteredIncidents,
          1.5
        );
        return result.nearbyIncidents;
      })()
    : undefined;

  const inboxParam = searchParams.get("inbox");
  const incidentParam = searchParams.get("incident");
  const tripParam = searchParams.get("trip");
  const hasPinDeepLink =
    searchParams.has("lat") && searchParams.has("lng");

  const mobilePrimarySwipeEnabled = useMemo(() => {
    if (typeof window === "undefined") return false;
    if (!window.matchMedia("(max-width: 767px)").matches) return false;
    if (inboxParam) return false;
    if (incidentParam) return false;
    if (tripParam) return false;
    if (hasPinDeepLink) return false;
    if (showInbox) return false;
    if (measureMode) return false;
    if (perimeterMode) return false;
    if (safetyEscapeOpen) return false;
    if (showAbout) return false;
    if (showLayers) return false;
    if (showUpgrade) return false;
    if (showTurnList) return false;
    if (alongRouteOpen) return false;
    if (sharedTrip) return false;
    if (tripRecap) return false;
    if (peekAnchor) return false;
    if (sidebarOpen) return false;
    if (selectedId) return false;
    if (clusterIncidentIds) return false;
    if (selectedDistrict) return false;
    if (mapTap) return false;
    return true;
  }, [
    inboxParam,
    incidentParam,
    tripParam,
    hasPinDeepLink,
    showInbox,
    measureMode,
    perimeterMode,
    safetyEscapeOpen,
    showAbout,
    showLayers,
    showUpgrade,
    showTurnList,
    alongRouteOpen,
    sharedTrip,
    tripRecap,
    peekAnchor,
    sidebarOpen,
    selectedId,
    clusterIncidentIds,
    selectedDistrict,
    mapTap,
  ]);

  useMobilePrimaryTabSwipe({ enabled: mobilePrimarySwipeEnabled });

  return (
    <div className="pp-app-shell relative w-full h-dvh min-h-0 overflow-hidden flex flex-col" style={{ background: "var(--map-bg)" }}>
      <MobileBottomNav />
      <InboxUrlSync 
        onInboxChange={handleInboxUrlChange} 
        onViewChange={(v) => { if (v) setViewTab(v); }} 
      />
      <AlertToast incidents={incidents} />

      {/* ──── Top Tab Bar (Map / Feed / Analytics) ──── */}
      {/* API Docs lives at /use-cases/api and is reachable from the More menu
          and from the Analytics header — surfacing it as a fourth top-bar tab
          is redundant and crowds the bar on mobile. */}
      <header
        className="pp-app-topnav relative z-[2000] hidden md:flex items-stretch shrink-0 isolate"
        style={{
          background: "var(--panel-bg)",
          borderBottom: "1px solid var(--panel-border)",
          boxShadow: "0 2px 12px var(--panel-shadow, rgba(0,0,0,0.25))",
        }}
      >
        {(["map", "feed", "analytics", "ask"] as const).map((tab) => {
          const active = viewTab === tab;
          return (
            <button
              key={tab}
              onClick={() => {
                if (tab === "analytics" && !isPro) {
                  setShowUpgrade("Analytics");
                  return;
                }
                if (tab === "ask" && !isPro) {
                  setShowUpgrade("Ask Pulse");
                  return;
                }
                setViewTab(tab);
              }}
              className="flex-1 flex items-center justify-center gap-2.5 py-3.5 text-xs font-bold tracking-widest uppercase transition-all relative"
              style={{
                color: active ? "#3b82f6" : "var(--panel-text-secondary)",
                background: active ? "var(--pp-accent-soft)" : "transparent",
              }}
            >
              {tab === "map" ? (
                <MapIcon className="w-4.5 h-4.5" />
              ) : tab === "feed" ? (
                <Radio className="w-4.5 h-4.5" />
              ) : tab === "analytics" ? (
                <BarChart3 className="w-4.5 h-4.5" />
              ) : (
                <MessageCircle className="w-4.5 h-4.5" />
              )}
              {tab === "map" ? "Map" : tab === "feed" ? "Feed" : tab === "analytics" ? "Analytics" : "Ask"}
              {tab === "analytics" && !isPro && <Lock className="w-2.5 h-2.5 text-purple-400 ml-1" />}
              {tab === "ask" && !isPro && <Lock className="w-2.5 h-2.5 text-purple-400 ml-1" />}
              {tab === "feed" && filteredIncidents.length > 0 && (
                <span
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded-full"
                  style={{
                    background: active ? "var(--pp-accent-bg)" : "var(--panel-input-bg)",
                    color: active ? "#3b82f6" : "var(--panel-text-muted)",
                  }}
                >
                  {filteredIncidents.length}
                </span>
              )}
              {/* Active indicator line */}
              {active && (
                <span
                  className="absolute bottom-0 left-[20%] right-[20%] h-[2px] rounded-full"
                  style={{ background: "#3b82f6" }}
                />
              )}
            </button>
          );
        })}
      </header>

      {/* ──── Content Area ──── */}
      <motion.div className="pp-app-main relative z-0 flex-1 min-h-0 w-full overflow-hidden isolate">

      {/* ──── Map view ──── */}
      <div
        className="absolute inset-0 flex flex-col overflow-hidden"
        style={{
          visibility: viewTab === "map" ? "visible" : "hidden",
          pointerEvents: viewTab === "map" ? "auto" : "none",
          opacity: viewTab === "map" ? 1 : 0,
          zIndex: viewTab === "map" ? 1 : 0,
        }}
      >
      <div className="absolute inset-0 overflow-hidden">
      <IncidentMap
        ref={mapRef}
        layersActive={viewTab === "map"}
        incidents={filteredIncidents}
        selectedId={selectedId}
        onSelectIncident={(id) => { setMapTap(null); setSelectedId(id); if (window.innerWidth < 768) setSidebarOpen(false); }}
        routes={routes}
        onMapTap={(lat, lng) => {
          if (measureMode) {
            // Measure mode swallows the tap — append to vertices and
            // skip every other map-tap side effect (SafetyScoreCard,
            // etc.) so the user can chain points without losing UI state.
            setMeasurePoints((p) => [...p, [lat, lng]]);
            return;
          }
          if (perimeterMode) {
            // Perimeter mode — append vertices to form a polygon.
            setPerimeterPoints((p) => [...p, [lat, lng]]);
            return;
          }
          setSelectedId(null);
          setMapTap({ lat, lng });
        }}
        onLongPress={(lat, lng) => {
          // Long-press / right-click → "What's happening here?" peek.
          // Read-only summary; no save state created, so an accidental
          // press costs the user nothing. Save-place flow is reached
          // through search results (see SearchSidebar) instead — the
          // map is too imprecise for thumb-chosen pins. Clear competing
          // overlays so we don't end up with two cards in the same
          // bottom-left slot.
          setMapTap(null);
          setSelectedId(null);
          setClusterIncidentIds(null);
          setSelectedDistrict(null);
          setPeekAnchor({ lat, lng });
        }}
        measurePoints={measureMode ? measurePoints : null}
        perimeterPoints={perimeterMode ? perimeterPoints : null}
        onMapMove={(_lat, _lng, zoom) => {
          // Keep the badge's viewport-bounded counter in sync. Read
          // bounds via the imperative handle (not lat/lng) so we get
          // the full {N,S,E,W} rectangle the badge needs. The
          // dispatchMove inside IncidentMap is already debounced 250ms.
          const moveBounds = mapRef.current?.getBounds();
          if (moveBounds) setMapBounds(moveBounds);

          // Persistent Safety-POI overlay: refetch when the viewport
          // shifts meaningfully *and* at least one category is on. We
          // gate on zoom ≥ 12 to avoid pulling thousands of POIs at
          // city-wide zooms; the layer toggles a hint when off-zoom.
          if (safetyPoiCats.size > 0 && zoom >= 12) {
            const bounds = mapRef.current?.getBounds();
            if (!bounds) return;
            const bboxKey = `${bounds.south.toFixed(2)},${bounds.west.toFixed(2)},${bounds.north.toFixed(2)},${bounds.east.toFixed(2)}:${[...safetyPoiCats].sort().join(",")}`;
            if (bboxKey === lastSafetyBboxRef.current) return;
            lastSafetyBboxRef.current = bboxKey;
            const seq = ++safetyFetchSeqRef.current;
            void (async () => {
              const enabled = [...safetyPoiCats];
              const results = await Promise.all(
                enabled.map((cat) => fetchPoisInBounds(cat, bounds, 60))
              );
              if (seq !== safetyFetchSeqRef.current) return;
              const flat = results.flat().map((p) => ({
                id: p.id,
                name: p.name,
                category: p.category as SafetyPoiCategory,
                lat: p.lat,
                lng: p.lng,
              }));
              setSafetyPois(flat);
            })();
          } else if (safetyPoiCats.size === 0 && safetyPois.length > 0) {
            setSafetyPois([]);
            lastSafetyBboxRef.current = "";
          }

          // Same gating logic for the convenience POI overlay. Slightly
          // stricter zoom floor (≥13) since these categories tend to be
          // much denser — pulling all of Philly's restaurants at z12
          // would be both slow and visually overwhelming.
          if (nearbyPoiCats.size > 0 && zoom >= 13) {
            const bounds = mapRef.current?.getBounds();
            if (!bounds) return;
            const bboxKey = `${bounds.south.toFixed(2)},${bounds.west.toFixed(2)},${bounds.north.toFixed(2)},${bounds.east.toFixed(2)}:${[...nearbyPoiCats].sort().join(",")}`;
            if (bboxKey === lastNearbyBboxRef.current) return;
            lastNearbyBboxRef.current = bboxKey;
            const seq = ++nearbyFetchSeqRef.current;
            void (async () => {
              const enabled = [...nearbyPoiCats];
              const results = await Promise.all(
                enabled.map((cat) => fetchPoisInBounds(cat, bounds, 80))
              );
              if (seq !== nearbyFetchSeqRef.current) return;
              const flat = results.flat().map((p) => ({
                id: p.id,
                name: p.name,
                category: p.category as NearbyPoiCategory,
                lat: p.lat,
                lng: p.lng,
              }));
              setNearbyPois(flat);
            })();
          } else if (nearbyPoiCats.size === 0 && nearbyPois.length > 0) {
            setNearbyPois([]);
            lastNearbyBboxRef.current = "";
          }
        }}
        mapTapActive={mapTap !== null}
        userLocation={userLocation}
        userHeading={userHeading}
        basemapStyle={basemapStyle}
        sharedTripGeometry={sharedTrip?.geometry || null}
        sharedTripDestination={sharedTrip?.destination || null}
        onUserDrag={() => {
          if (tripGeometry && followMe) setFollowMe(false);
        }}
        tripRouteGeometry={tripGeometry}
        previewOrigin={previewOrigin}
        previewDest={previewDest}
        previewWaypoints={previewWaypoints}
        tripMode={tripMode}
        heatmapEnabled={heatmapEnabled}
        todHourFocus={todHourFocus}
        safetyPois={safetyPois}
        nearbyPois={nearbyPois}
        parkedPin={parkedPin ? { lat: parkedPin.lat, lng: parkedPin.lng } : null}
        savedPlaces={isPro && savedPlacesOverlay && savedDestinations.length > 0
          ? savedDestinations.map((d) => {
              // Mirror the SavedPlaces palette logic for list-bound
              // entries so the on-map dot matches its sidebar row.
              let accent: string | undefined;
              if (d.category === "custom" && d.listId) {
                const list = savedLists.find((l) => l.id === d.listId);
                if (list) {
                  accent = list.color || (() => {
                    const palette = ["#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#fb7185", "#5eead4"];
                    let hash = 0;
                    for (let i = 0; i < list.id.length; i++) hash = (hash * 31 + list.id.charCodeAt(i)) & 0xfffffff;
                    return palette[hash % palette.length];
                  })();
                }
              }
              return {
                id: d.id,
                name: d.name,
                lat: d.lat,
                lng: d.lng,
                category: d.category,
                accentColor: accent,
              };
            })
          : null}
        onSavedPlaceClick={(_id, lat, lng, name) => {
          // Mirror the existing place-actions flow: clicking a saved
          // pin opens directions *to* it. For Home/Work specifically
          // this matches the quick-route chip behavior.
          window.dispatchEvent(
            new CustomEvent("pp:plan-route", { detail: { mode: "to", lat, lng, label: name } })
          );
        }}
        isDark={isDark}
        onTripProgress={setTripProgress}
        liveTripGps={gpsStatus === "found"}
        timeFilterHours={timeFilter}
        heatmapDemoBoost={false}
        districtsEnabled={districtsEnabled}
        onDistrictClick={(district, incs) => setSelectedDistrict({ district, incidents: incs })}
        onClusterClick={(ids) => { setSelectedId(null); setClusterIncidentIds(ids); }}
      />
      </div>

      {/* Mobile sidebar toggle */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="md:hidden fixed z-[2001] w-10 h-10 flex items-center justify-center rounded-lg backdrop-blur-md shadow-lg"
        style={{
          background: "var(--pill-bg)",
          border: "1px solid var(--pill-border)",
          color: "var(--pill-text)",
          bottom: sidebarOpen ? "calc(55vh + 0.5rem)" : "1rem",
          left: "0.75rem",
          transition: "bottom 0.3s ease",
        }}
      >
        {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {/* Mobile top search pill — Google-Maps-style entry into the search
          sheet. Hidden on desktop (sidebar is always visible there) and
          while the bottom sheet is open (the real search input is then
          on-screen so a duplicate affordance would be noise). */}
      {!sidebarOpen && (
        <button
          onClick={() => {
            setSidebarOpen(true);
            // Let the vaul snap-in finish before stealing focus, otherwise
            // mobile Safari can race the animation and skip the keyboard.
            window.setTimeout(() => {
              window.dispatchEvent(new CustomEvent("pp:focus-search"));
            }, 260);
          }}
          className="md:hidden fixed z-[2001] left-3 right-3 flex items-center gap-2 px-3.5 py-2.5 rounded-full backdrop-blur-md shadow-lg"
          style={{
            top: "calc(env(safe-area-inset-top, 0px) + 0.625rem)",
            background: "var(--pill-bg)",
            border: "1px solid var(--pill-border)",
            color: "var(--pill-text)",
          }}
          aria-label="Search places, addresses, or set a route"
        >
          <Search className="w-4 h-4 opacity-75 shrink-0" aria-hidden />
          <span className="text-sm opacity-75 truncate text-left flex-1">
            Search places, addresses, set a route
          </span>
        </button>
      )}

      {/* Sidebar (desktop: side panel; mobile: vaul snap-point bottom sheet) */}
      <SearchSidebar
        incidents={filteredIncidents}
        onFlyTo={(lat, lng) => mapRef.current?.flyTo(lat, lng)}
        onRoutesChange={setRoutes}
        onUserLocation={(lat, lng) => setUserLocation({ lat, lng })}
          onTripActive={(active, geometry, m, steps, meta) => {
            setTripGeometry(active && geometry ? geometry : null);
            setTripMode(active && m ? m : null);
            setTripSteps(active && steps && steps.length > 0 ? steps : null);
            if (active) {
              // Snapshot the trip's static metadata at start so we can
              // build a recap card when it ends (the SearchSidebar's
              // `routeInfo` is gone by then).
              setFollowMe(true);
              // Fresh trip → re-arm the parking-on-approach pill so the
              // user sees the prompt even if they dismissed it last
              // drive.
              setParkingPillDismissed(false);
              if (meta) {
                // Decimate the polyline down to ~120 vertices for
                // GPX export. Long routes can have 2000+ raw points
                // which would blow the localStorage budget once we
                // multiply by MAX_ENTRIES history entries.
                let geomForHistory: [number, number][] | undefined;
                if (geometry && geometry.length >= 2) {
                  const target = 120;
                  if (geometry.length <= target) {
                    geomForHistory = geometry.slice();
                  } else {
                    const step = (geometry.length - 1) / (target - 1);
                    const decimated: [number, number][] = [];
                    for (let i = 0; i < target; i++) {
                      decimated.push(geometry[Math.round(i * step)]);
                    }
                    geomForHistory = decimated;
                  }
                }
                tripStatsRef.current = {
                  startedAt: Date.now(),
                  totalDistanceKm: meta.distanceKm,
                  mode: m || "driving-car",
                  nearbyIncidents: meta.nearbyCount,
                  wasSafeRoute: meta.isSafe,
                  origin: meta.origin,
                  dest: meta.dest,
                  geometry: geomForHistory,
                };
                // Spoken departure summary — once at trip start. We
                // delay slightly so the manuever chip's first
                // "in 200m, turn left" doesn't get cut off; "info"
                // priority queues behind any pending turn cues.
                const destName = meta.dest?.display_name?.split(",")[0] || "your destination";
                const km = meta.distanceKm;
                const distPhrase = km >= 1
                  ? `${km.toFixed(1)} kilometer trip`
                  : `${Math.round(km * 1000)} meter trip`;
                void import("@/lib/voice-nav").then(({ speakNav }) => {
                  speakNav(
                    `Starting ${distPhrase} to ${destName}.`,
                    { priority: "info", dedupeKey: "trip-start", dedupeMs: 5000 }
                  );
                });
              }
            } else if (tripStatsRef.current) {
              // Spoken arrival / end summary. Treat 95%+ progress as a
              // proper arrival ("You have arrived"), anything less as a
              // manual end ("Trip ended"). We fire this *before*
              // building the recap so the announcement matches what
              // the user sees on screen.
              const progress = lastTripProgressRef.current;
              const arrived = progress >= 0.95;
              void import("@/lib/voice-nav").then(({ speakNav }) => {
                speakNav(
                  arrived
                    ? `You have arrived at your destination.`
                    : `Trip ended.`,
                  { priority: "info", dedupeKey: "trip-end", dedupeMs: 10_000 }
                );
              });
            }
            if (!active && tripStatsRef.current) {
              // Trip ended — emit a recap. We treat 95%+ progress as a
              // completed arrival, anything less as a manual end.
              const stats = tripStatsRef.current;
              const progress = lastTripProgressRef.current;
              const completed = progress >= 0.95;
              const recap: TripRecap = {
                startedAt: stats.startedAt,
                endedAt: Date.now(),
                totalDistanceKm: stats.totalDistanceKm,
                traveledKm: stats.totalDistanceKm * Math.min(1, Math.max(0, progress)),
                mode: stats.mode,
                nearbyIncidents: stats.nearbyIncidents,
                wasSafeRoute: stats.wasSafeRoute,
                completed,
              };
              setTripRecap(recap);
              // Persist to history so the SearchSidebar's Recent Trips
              // section picks it up. Skip 0-distance "trips" (e.g. user
              // immediately bailed) since they'd just clutter the list.
              if (recap.traveledKm >= 0.05) {
                const entry = recordTrip({
                  ...recap,
                  origin: stats.origin,
                  dest: stats.dest,
                  geometry: stats.geometry,
                });
                setTripRecapHistoryId(entry.id);
              } else {
                setTripRecapHistoryId(null);
              }
              tripStatsRef.current = null;
            }
          }}
        onPreviewPins={(origin, dest) => {
          setPreviewOrigin(origin);
          setPreviewDest(dest);
        }}
        onPreviewWaypoints={setPreviewWaypoints}
        onSelectIncident={setSelectedId}
        selectedId={selectedId}
        tripProgress={tripProgress}
        onGpsStatusChange={setGpsStatus}
        timeFilterLabel={activeTimeLabel}
        timeFilterHours={timeFilter}
        trendPct={trendPct}
        hotNeighborhoods={hotNeighborhoods}
        categoryBreakdown={categoryBreakdown}
        hourlyData={hourlyData}
        onToggleCat={toggleCat}
        mobileOpen={sidebarOpen}
        onMobileOpenChange={setSidebarOpen}
      />

      {/* Map filters — mobile: bottom strip above nav; desktop: stacked rows
          in the map canvas right of SearchInput (--pp-map-filters-left). */}
      <div
        className="pp-map-filter-rail pointer-events-none absolute z-[1001] max-md:bottom-[calc(64px+env(safe-area-inset-bottom,0px)+0.75rem)] max-md:inset-x-3 max-md:top-auto max-md:left-3 max-md:right-3"
      >
        <div className="flex flex-col items-stretch gap-2.5 md:gap-3 min-w-0 pointer-events-auto">
          <div
            className="flex items-center rounded-full shadow-lg backdrop-blur-md overflow-x-auto no-scrollbar min-w-0 w-full"
            style={{ background: "var(--pill-bg)", border: "1px solid var(--pill-border)" }}
          >
            <Clock className="w-4 h-4 ml-3 md:ml-4 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
            {TIME_FILTERS.map((tf) => {
              const locked = tf.pro && !isPro;
              return (
                <button
                  key={tf.label}
                  onClick={() => {
                    if (locked) { setShowUpgrade("Extended History"); return; }
                    setTimeFilter(tf.hours);
                  }}
                  className={`px-3 md:px-4 py-2 md:py-2.5 text-xs md:text-sm font-medium transition-colors relative shrink-0 ${
                    timeFilter === tf.hours ? "bg-blue-500/15 text-blue-500" : ""
                  } ${locked ? "opacity-50" : ""}`}
                  style={timeFilter !== tf.hours ? { color: locked ? "var(--panel-text-muted)" : "var(--pill-text)" } : {}}
                  title={locked ? "Pro feature · upgrade to unlock" : undefined}
                >
                  {tf.label}
                  {locked && <Lock className="w-3 h-3 absolute -top-0.5 -right-0.5 text-purple-400" />}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar min-w-0 w-full">
            <FilterPresetsBar
              activeCats={activeCats}
              timeFilterHours={timeFilter}
              onApply={(cats, hours) => {
                setActiveCats(cats);
                const tf = TIME_FILTERS.find((t) => t.hours === hours);
                if (tf?.pro && !isPro) {
                  setShowUpgrade("Extended History");
                  return;
                }
                setTimeFilter(hours);
              }}
            />

            <button
              onClick={() => setActiveCats(new Set())}
              className={`flex items-center gap-1.5 px-3 md:px-4 py-2 md:py-2.5 rounded-full text-xs md:text-sm font-medium transition-all shrink-0 backdrop-blur-md shadow-lg ${
                activeCats.size === 0 ? "bg-blue-500/15 text-blue-500 ring-1 ring-blue-500/30" : "opacity-70 hover:opacity-100"
              }`}
              style={activeCats.size > 0 ? { background: "var(--pill-bg)", border: "1px solid var(--pill-border)", color: "var(--pill-text)" } : { background: "var(--pp-accent-bg)", border: "1px solid var(--pp-accent-border)" }}
            >
              All
            </button>

            {CATEGORY_PILLS.map((pill) => {
              const Icon = pill.icon;
              const isActive = pill.cats.some((c) => activeCats.has(c));
              const count = filteredIncidents.filter(i => (pill.cats as readonly string[]).includes(i.severity_category)).length;
              return (
                <button
                  key={pill.label}
                  onClick={() => toggleCat(pill.cats)}
                  className={`flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-2 md:py-2.5 rounded-full text-xs md:text-sm font-medium transition-all shrink-0 backdrop-blur-md shadow-lg ${
                    isActive ? "ring-1" : "opacity-70 hover:opacity-100"
                  }`}
                  style={{
                    background: isActive ? withAlpha(pill.color, 9) : "var(--pill-bg)",
                    border: `1px solid ${isActive ? withAlpha(pill.color, 25) : "var(--pill-border)"}`,
                    color: isActive ? pill.color : "var(--pill-text)",
                  }}
                >
                  <Icon className="w-4 h-4 md:w-4.5 md:h-4.5" />
                  <span className="hidden md:inline">{pill.label}</span>
                  {count > 0 && (
                    <span className="text-[11px] font-mono" style={{ opacity: isActive ? 1 : 0.5 }}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Recipient view of a "Share my live ETA" link (?trip=<token>). */}
      {sharedTrip && (
        <SharedTripCard trip={sharedTrip} onClose={() => setSharedTrip(null)} />
      )}

      {/* Live GPS speed readout for driving / cycling trips. */}
      {speedTracked && <SpeedChip mps={tripSpeedMps} loc={userLocation} />}

      {/* Parked-here pill — appears whenever a parked-pin is active.
          Auto-dismisses on TTL expiry; user can also clear via the X.
          Hidden during an in-trip recap to avoid stacking modals. */}
      {!tripRecap && (
        <ParkedPinPill
          userLocation={userLocation}
          onLocate={(lat, lng) => mapRef.current?.flyTo(lat, lng, 18)}
        />
      )}

      {/* Global undo toast host — destructive actions across the app
          (trip-history delete, parked-pin clear, list delete) route
          through `requestUndoableAction` and surface here. */}
      <UndoToastHost />

      {/* Press `?` (or Shift+/) to open the keyboard shortcuts cheat
          sheet. The component owns its own open state and listens for
          the key directly — page only mounts it. */}
      <KeyboardShortcutsHelp />

      {/* PWA install / iOS Add to Home Screen — must be mounted for
          `requestInstallPrompt()` (push settings, alerts) to work. */}
      <InstallPrompt />

      {/* Scheduled-trip reminder runner + banner. Runner is headless
          (renders nothing); it sweeps localStorage on mount, arms
          timers / polling, and dispatches `pp:trip-reminder` events.
          The banner subscribes to those events and shows the toast
          UI. Mounted at root so reminders fire regardless of which
          panel/sidebar the user is currently looking at. */}
      <ReminderRunner />
      <ReminderBanner />

      {/* Predictive "leaving for work" Web Notification. Headless;
          all gating (opt-in flag, browser permission, quiet hours,
          fired-today) lives in lib/commute-notify. Mounted at root
          so it keeps polling regardless of which panel is open. */}
      <CommuteNotifier />

      {/* First-run map gestures tutorial. Auto-opens once on first
          visit; thereafter only on demand via a `pp:show-gestures-
          tour` window event (fired from the keyboard help sheet). */}
      <MapGesturesTour />

      {/* In-app feedback / bug-report modal. Mounted at root and
          listens for `pp:open-feedback` window events so any surface
          (about panel, error banners) can summon it without prop
          drilling. */}
      <FeedbackForm />

      {/* Resume-trip pill — surfaces a recent in-progress trip after a
          page refresh / accidental tab close. Hides once the user
          chooses (resume re-fires startTrip via pp:resume-trip; dismiss
          drops the snapshot from localStorage). */}
      {resumeSnap && !tripGeometry && (
        <ResumeTripPill
          destName={resumeSnap.dest.display_name.split(",")[0] || "destination"}
          startedAt={resumeSnap.startedAt}
          onResume={() => {
            const snap = resumeSnap;
            setResumeSnap(null);
            window.dispatchEvent(new CustomEvent("pp:resume-trip", { detail: snap }));
          }}
          onDismiss={() => {
            clearTripSnapshot();
            setResumeSnap(null);
          }}
        />
      )}

      {/* Off-screen incident chip — pops up for fresh, high-severity
          incidents outside the current viewport. Tap to fly there. */}
      {offscreenAlert && (
        <OffscreenIncidentChip
          incident={offscreenAlert.incident}
          bearingDeg={offscreenAlert.bearingDeg}
          onTap={() => {
            const { incident } = offscreenAlert;
            setOffscreenAlert(null);
            if (incident.lat != null && incident.lng != null) {
              mapRef.current?.flyTo(incident.lat, incident.lng, 16);
            }
            setSelectedId(incident.id);
          }}
          onDismiss={() => {
            dismissedAlertIdsRef.current.add(offscreenAlert.incident.id);
            setOffscreenAlert(null);
          }}
        />
      )}

      {/* Incident-ahead chip — only shown during an active trip when
          there's a high-severity incident on the route in front of
          the user. Tap to fly to it; X to dismiss for the trip. */}
      {aheadAlert && (
        <IncidentAheadChip
          incident={aheadAlert.incident}
          distanceM={aheadAlert.distanceM}
          onTap={() => {
            const { incident } = aheadAlert;
            if (incident.lat != null && incident.lng != null) {
              mapRef.current?.flyTo(incident.lat, incident.lng, 17);
            }
            setSelectedId(incident.id);
          }}
          onDismiss={() => {
            aheadDismissedRef.current.add(aheadAlert.incident.id);
            setAheadAlert(null);
          }}
        />
      )}

      {/* Re-center pill — shown only during a trip when follow-me has been
          disabled by manual drag. Tapping it pans back to the user. */}
      {tripGeometry && !followMe && userLocation && (
        <RecenterPill
          onClick={() => {
            setFollowMe(true);
            mapRef.current?.panTo?.(userLocation.lat, userLocation.lng);
          }}
        />
      )}

      {/* "Need parking?" approach pill — only visible when the user is
          driving _and_ within the last ~800 m of their trip. We gate
          on absolute remaining distance (not a raw progress %) so the
          prompt fires at the same physical proximity regardless of
          trip length. Dismissed-state is per-trip and resets on
          trip start. */}
      {tripGeometry &&
        tripMode === "driving-car" &&
        !parkingPillDismissed &&
        !alongRouteOpen &&
        tripStatsRef.current?.totalDistanceKm != null &&
        (1 - tripProgress) * tripStatsRef.current.totalDistanceKm * 1000 < 800 &&
        tripProgress < 0.99 && (
          <ParkingApproachPill
            onOpenParking={() => {
              setAlongRouteInitialCategory("parking");
              setAlongRouteOpen(true);
              setParkingPillDismissed(true);
            }}
            onDismiss={() => setParkingPillDismissed(true)}
          />
        )}

      {/* Search-along-route drawer — bottom-anchored, only visible
          during an active trip. Issues a single Overpass bbox query
          per category and ranks POIs by detour distance. */}
      {tripGeometry && alongRouteOpen && (
        <AlongRoutePanel
          geometry={tripGeometry}
          userLocation={userLocation}
          initialCategory={alongRouteInitialCategory}
          onClose={() => {
            setAlongRouteOpen(false);
            // Clear the auto-pick so the next manual open returns to
            // the empty "pick a chip" state.
            setAlongRouteInitialCategory(undefined);
          }}
        />
      )}

      {/* Get-to-safety panel — bottom-anchored emergency sheet with
          the closest staffed safe spaces (police / hospital / fire /
          24h gas) plus a one-tap Call 911. Available at all times
          (with or without an active trip) since the user may be in
          distress when they reach for it. */}
      {safetyEscapeOpen && (
        <SafetyEscapePanel
          userLocation={userLocation}
          onClose={() => setSafetyEscapeOpen(false)}
        />
      )}

      {/* Maneuver chip — floating turn-by-turn pill (active trip + ORS steps only) */}
      {tripGeometry && tripSteps && tripSteps.length > 0 && (
        <div
          className="absolute z-[1002] left-1/2 -translate-x-1/2 pointer-events-none flex justify-center"
          style={{
            top: "calc(env(safe-area-inset-top, 0px) + 4rem)",
            width: "min(440px, calc(100vw - 1.5rem))",
          }}
        >
          <ManeuverChip
            steps={tripSteps}
            geometry={tripGeometry}
            tripProgress={tripProgress}
            onShowSteps={() => setShowTurnList(true)}
          />
        </div>
      )}

      {/* Full upcoming-turns list (toggled by the chip's "Steps" button) */}
      {showTurnList && tripGeometry && tripSteps && tripSteps.length > 0 && (
        <TurnList
          steps={tripSteps}
          geometry={tripGeometry}
          tripProgress={tripProgress}
          onClose={() => setShowTurnList(false)}
        />
      )}

      {/* Bottom-right controls (lifted so map markers under corner overlap UI less) */}
      <div className="absolute md:bottom-[4.5rem] pp-bottom-controls right-3 z-[1001] flex flex-col items-end gap-1.5 md:gap-2 pointer-events-auto">
        {/* Measurement readout — sits at the very top of the column
            when active so the running distance is the first thing the
            user reads after dropping a vertex. Renders nothing in
            non-measure mode. */}
        <MeasureToolPanel
          active={measureMode}
          points={measurePoints}
          onToggle={() => {
            // Exiting measure mode also clears the polyline so re-
            // entering starts fresh — saves the user a "Clear" tap.
            setMeasureMode(false);
            setMeasurePoints([]);
          }}
          onUndo={() => setMeasurePoints((p) => p.slice(0, -1))}
          onClear={() => setMeasurePoints([])}
        />
        {/* Perimeter readout — event security polygon tool */}
        {perimeterMode && perimeterPoints.length >= 1 && (() => {
          // Point-in-polygon (ray casting) for incident counting
          const pts = perimeterPoints;
          const insideCount = pts.length >= 3
            ? filteredIncidents.filter((inc) => {
                if (inc.lat == null || inc.lng == null) return false;
                let inside = false;
                for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                  const [yi, xi] = pts[i];
                  const [yj, xj] = pts[j];
                  if (
                    ((yi > inc.lat) !== (yj > inc.lat)) &&
                    (inc.lng! < ((xj - xi) * (inc.lat - yi)) / (yj - yi) + xi)
                  ) {
                    inside = !inside;
                  }
                }
                return inside;
              }).length
            : 0;
          return (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs backdrop-blur-md shadow-lg"
              style={{
                background: "var(--pill-bg)",
                border: "1px solid var(--pill-border)",
                color: "var(--panel-text)",
              }}
            >
              <Shield className="w-4 h-4 text-purple-400" />
              <div className="flex flex-col">
                <span className="font-semibold">
                  Perimeter · {pts.length} {pts.length === 1 ? "vertex" : "vertices"}
                </span>
                {pts.length >= 3 ? (
                  <span className="text-[10px]" style={{ color: insideCount > 0 ? "#f59e0b" : "#22c55e" }}>
                    {insideCount} incident{insideCount !== 1 ? "s" : ""} inside
                  </span>
                ) : (
                  <span className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
                    Tap {3 - pts.length} more {3 - pts.length === 1 ? "point" : "points"} to close polygon
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 ml-auto">
                <button
                  onClick={() => setPerimeterPoints((p) => p.slice(0, -1))}
                  className="px-1.5 py-0.5 rounded text-[10px]"
                  style={{ background: "var(--panel-input-bg)", color: "var(--panel-text-muted)" }}
                  title="Undo last point"
                >
                  Undo
                </button>
                <button
                  onClick={() => { setPerimeterMode(false); setPerimeterPoints([]); }}
                  className="p-1 rounded-full"
                  style={{ color: "var(--panel-text-muted)" }}
                  title="Close perimeter tool"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })()}
        {/* Live ETA share — Firestore-backed, only visible while a
            trip is active. Owns its own state; we just hand it the
            trip metadata. Tucked into the bottom-right column so it
            sits next to the other trip-only controls. */}
        {tripGeometry && tripGeometry.length > 1 && (
          <LiveSharePill
            active={Boolean(tripGeometry)}
            userLocation={userLocation}
            userHeading={userHeading}
            progressPct={tripProgress}
            speedMps={tripSpeedMps}
            totalDistanceKm={tripStatsRef.current?.totalDistanceKm ?? 0}
            dest={
              tripStatsRef.current?.dest
                ? {
                    lat: tripStatsRef.current.dest.lat,
                    lng: tripStatsRef.current.dest.lng,
                    name: tripStatsRef.current.dest.display_name.split(",")[0] || "destination",
                  }
                : null
            }
            mode={tripMode}
          />
        )}
        {/* Get-to-safety — always visible. Distinct red shield with a
            subtle breathing pulse so it's findable at a glance when
            the user actually needs it. Tapping opens a sheet with the
            closest staffed safe spaces and a Call 911 button. */}
        <SafetyEscapeButton
          active={safetyEscapeOpen}
          onClick={() => setSafetyEscapeOpen((v) => !v)}
        />

        {/* "Search along route" — only meaningful while a trip is
            active; hidden the rest of the time so the button column
            doesn't grow unnecessarily. Toggles a bottom-anchored
            panel similar to Maps' search-along-route drawer. */}
        {tripGeometry && tripGeometry.length > 1 && (
          <button
            type="button"
            onClick={() => setAlongRouteOpen((v) => !v)}
            title="Search along route"
            aria-label="Search along route"
            className="w-10 h-10 flex items-center justify-center rounded-lg backdrop-blur-md shadow-lg transition-colors active:scale-95"
            style={{
              background: alongRouteOpen ? "var(--pp-accent-bg)" : "var(--pill-bg)",
              border: `1px solid ${alongRouteOpen ? "var(--pp-accent-border)" : "var(--pill-border)"}`,
              color: alongRouteOpen ? "#3b82f6" : "var(--pill-text)",
            }}
          >
            <Search className="w-4 h-4" />
          </button>
        )}
        {/* Compass — only renders when the device is publishing a
            heading (iOS gates this behind a permission grant the
            useDeviceHeading hook handles). The face stays north-up
            with the map; a red arrow shows which way the user is
            facing. Tapping recenters on the user, mirroring Maps. */}
        <CompassIndicator
          heading={userHeading ?? null}
          onClick={userLocation ? goToMyLocation : undefined}
        />
        <button
          type="button"
          onClick={goToMyLocation}
          title="My location"
          aria-label="Center map on my location"
          className="w-12 h-12 flex items-center justify-center rounded-lg backdrop-blur-md shadow-lg transition-opacity hover:opacity-90 active:scale-95"
          style={{
            background: "var(--pill-bg)",
            border: "1px solid var(--pill-border)",
            color: "var(--panel-text)",
          }}
        >
          <LocateFixed className="w-5 h-5" />
        </button>
        <button
          type="button"
          onClick={recenterCity}
          title="City overview"
          aria-label={`Recenter map on ${cityDisplayName}`}
          className="w-12 h-12 flex items-center justify-center rounded-lg backdrop-blur-md shadow-lg transition-opacity hover:opacity-90 active:scale-95"
          style={{
            background: "var(--pill-bg)",
            border: "1px solid var(--pill-border)",
            color: "var(--panel-text)",
          }}
        >
          <House className="w-5 h-5" />
        </button>
        <AuthBar />
        <PulseNetworkNav />

        {/* Alerts inbox bell — surfaces persisted off-screen / on-route
            alerts so users can scroll back through what they may have
            missed. Unread badge updates live via the alerts-inbox pubsub.
            Hidden on mobile because the bottom-nav Inbox tab opens the
            same drawer (and `?inbox=…` deep links are redirected to
            /inbox and /more by InboxUrlSync). Less buttons in the right
            rail = a calmer mobile map. */}
        <div className="relative hidden md:block">
          <button
            onClick={() => {
              setShowInbox(!showInbox);
              setShowLayers(false);
            }}
            className="w-12 h-12 flex items-center justify-center rounded-lg backdrop-blur-md shadow-lg transition-colors"
            style={{
              background: showInbox ? "var(--pp-accent-bg)" : "var(--pill-bg)",
              border: `1px solid ${showInbox ? "var(--pp-accent-border)" : "var(--pill-border)"}`,
              color: showInbox ? "#3b82f6" : "var(--pill-text)",
            }}
            title={`Alerts (${unreadAlerts} unread)`}
            aria-label={`Alerts inbox, ${unreadAlerts} unread`}
          >
            <Bell className="w-5 h-5" />
            {unreadAlerts > 0 && (
              <span
                className="absolute -top-0.5 -right-0.5 min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center text-[10px] font-bold rounded-full tabular-nums"
                style={{ background: "#ef4444", color: "#fff" }}
                aria-hidden="true"
              >
                {unreadAlerts > 9 ? "9+" : unreadAlerts}
              </span>
            )}
          </button>
          <AlertsInbox
            open={showInbox}
            defaultPanel={inboxPanel}
            onClose={() => {
              setShowInbox(false);
              // Clean the URL so reopening via the bell isn't stuck
              // on whatever panel the deep-link last requested.
              if (typeof window !== "undefined" && window.location.search.includes("inbox=")) {
                const u = new URL(window.location.href);
                u.searchParams.delete("inbox");
                window.history.replaceState({}, "", u.toString());
              }
              setInboxPanel("list");
            }}
            onJump={(incidentId, lat, lng) => {
              mapRef.current?.flyTo(lat, lng, 16);
              setSelectedId(incidentId);
            }}
          />
        </div>

        <MoreMenu
          mode={mode}
          setMode={setMode}
          heatmapEnabled={heatmapEnabled}
          setHeatmapEnabled={setHeatmapEnabled}
          districtsEnabled={districtsEnabled}
          setDistrictsEnabled={setDistrictsEnabled}
          todOverlayEnabled={todOverlayEnabled}
          setTodOverlayEnabled={setTodOverlayEnabled}
          todHourFocus={todHourFocus}
          vectorTilesEnabled={vectorTilesEnabled}
          setVectorTilesEnabled={setVectorTilesEnabled}
          savedPlacesOverlay={savedPlacesOverlay}
          setSavedPlacesOverlay={setSavedPlacesOverlay}
          colorBlindSafe={colorBlindSafe}
          setColorBlindSafe={setColorBlindSafe}
          isPro={isPro}
          open={showLayers}
          setOpen={setShowLayers}
          onShowAbout={() => setShowAbout(true)}
          onShowUpgrade={(feature) => setShowUpgrade(feature)}
        />
      </div>

      {/* Bottom status bar */}
      <div className="absolute bottom-0 left-0 md:left-[var(--pp-map-sidebar-width,380px)] right-0 z-[998] pointer-events-none hidden md:block">
        <div
          className="flex items-center justify-between px-4 py-2 backdrop-blur-md"
          style={{ background: "var(--status-bg)", borderTop: "1px solid var(--status-border)" }}
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[10px] text-green-500 font-medium">LIVE</span>
            </div>
            <span className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>·</span>
            <span className="text-[10px]" style={{ color: "var(--panel-text-secondary)" }}>
              {/* Numerator: incidents inside the current map viewport
                  (subject to time + category filters). Denominator:
                  total in the time window across the whole city —
                  uses the server-aggregated count when available
                  (long windows), falls back to the client-known set
                  otherwise. */}
              {(() => {
                const visible = visibleIncidents.length;
                const windowed = filteredIncidents.length;
                const total =
                  extendedTotal != null && extendedTotal > windowed
                    ? extendedTotal
                    : windowed;
                const noun = `incident${total !== 1 ? "s" : ""}`;
                const window = activeTimeLabel ? ` (${activeTimeLabel.toLowerCase()})` : "";
                if (!mapBounds || visible === total) {
                  return `${total.toLocaleString()} ${noun}${window} in ${cityDisplayName} metro`;
                }
                return `${visible.toLocaleString()} visible / ${total.toLocaleString()} ${noun}${window} in ${cityDisplayName} metro`;
              })()}
            </span>
            {extendedLoading && (
              <span
                className="text-[10px] flex items-center gap-1"
                style={{ color: "rgb(59, 130, 246)" }}
                aria-live="polite"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                loading history…
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {activeFeeds.length > 0 && (
              <div
                className="hidden sm:flex items-center gap-1.5 text-[10px]"
                style={{ color: "var(--panel-text-muted)" }}
                title={activeFeeds.map((f) => f.label).join("\n")}
              >
                <Radio className="w-3 h-3" />
                <span className="w-1 h-1 rounded-full bg-green-500" />
                {activeFeeds.length} feed{activeFeeds.length === 1 ? "" : "s"} live
              </div>
            )}
            <span className="text-[10px] hidden sm:inline" style={{ color: "var(--panel-text-muted)" }}>
              {new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })} EST
            </span>
            <img src="/logo.png" alt="" className="w-4 h-4 opacity-50" />
          </div>
        </div>
      </div>

      {/* About / transparency — full-screen overlay so it never stacks under
          the bottom-right tool rail (z-1001) or fights Pulse Network dropdowns. */}
      <AnimatePresence>
        {showAbout && (
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pp-about-title"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[2400] flex items-end justify-center md:items-center p-3 pb-10 md:pb-6 bg-black/55 backdrop-blur-[2px]"
            onClick={() => setShowAbout(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 28 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md max-h-[min(34rem,82dvh)] overflow-y-auto rounded-2xl shadow-2xl backdrop-blur-xl p-4 space-y-3 border"
              style={{ background: "var(--panel-bg)", borderColor: "var(--panel-border)" }}
            >
              <div className="flex items-start justify-between gap-3">
                <h3
                  id="pp-about-title"
                  className="font-semibold flex items-center gap-2 text-sm min-w-0"
                  style={{ color: "var(--panel-text)" }}
                >
                  <Shield className="w-4 h-4 text-blue-500 shrink-0" />
                  <span className="leading-snug">Transparency & Responsible AI</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setShowAbout(false)}
                  className="shrink-0 p-1.5 rounded-lg transition-colors hover:bg-white/10"
                  style={{ color: "var(--panel-text-muted)" }}
                  aria-label="Close about panel"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            <p className="text-xs leading-relaxed" style={{ color: "var(--panel-text-secondary)" }}>
              {cityDisplayName} Pulse uses AI at every layer: speech-to-text (Whisper)
              converts police scanner audio, an LLM extracts structured incident
              data, and geocoding places it on this map.
            </p>
            <p className="text-xs leading-relaxed" style={{ color: "var(--panel-text-secondary)" }}>
              Before display, each incident runs through a{" "}
              <strong className="text-blue-500">built-in guardrail</strong>{" "}
              (pattern checks for obvious PII and similar sensitive content in the transcript).
              Anything that fails that pass is kept off the public map.
            </p>
            {stats && (
              <div className="text-xs space-y-1.5 rounded-lg p-3" style={{ background: "var(--panel-input-bg)" }}>
                <p>
                  <span className="text-2xl font-bold text-blue-500">{stats.total_incidents}</span>
                  <span className="ml-2" style={{ color: "var(--panel-text-secondary)" }}>incidents processed</span>
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {Object.entries(stats.inhibitor_stats).map(([status, count]) => (
                    <Badge key={status} variant="outline" className="text-[10px] font-mono" style={{ borderColor: "var(--panel-border)", color: "var(--panel-text-secondary)" }}>
                      {status}: {count}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {summary && (
              <div className="rounded-lg p-3" style={{ background: "var(--panel-input-bg)" }}>
                <p className="text-[10px] text-blue-500 font-medium mb-1.5 flex items-center gap-1">
                  <Eye className="w-3 h-3" /> AI SUMMARY
                </p>
                <p className="text-xs leading-relaxed" style={{ color: "var(--panel-text-secondary)" }}>{summary}</p>
              </div>
            )}
            <p
              className="text-[10px] leading-relaxed pt-3"
              style={{ borderTop: "1px solid var(--panel-border)", color: "var(--panel-text-muted)" }}
            >
              Scanner feeds are public and machine-processed. Pins are for general awareness, not
              verified facts, dispatch records, or emergency decision-making.
            </p>

            {/* Feedback shortcut at the bottom of About; form is a global modal. */}
            <button
              type="button"
              onClick={() => {
                setShowAbout(false);
                window.dispatchEvent(new CustomEvent("pp:open-feedback"));
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
              style={{
                background: "var(--pp-accent-soft)",
                color: "#3b82f6",
                border: "1px solid var(--pp-accent-border)",
              }}
            >
              Send feedback or report a bug
            </button>
            {/* Public moderation transparency. Same audience as the
                feedback CTA — users curious enough to read the
                disclaimer are also the ones who appreciate a
                receipts-style breakdown of how reports are handled. */}
            <a
              href="/transparency"
              onClick={() => setShowAbout(false)}
              className="mt-2 w-full inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
              style={{
                background: "rgba(168,85,247,0.10)",
                color: "#a855f7",
                border: "1px solid rgba(168,85,247,0.30)",
              }}
            >
              See community moderation transparency →
            </a>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Safety Score Card */}
      <AnimatePresence>
        {mapTap && !selected && viewTab !== "analytics" && viewTab !== "ask" && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-3 md:bottom-16 left-3 md:left-[calc(var(--pp-map-sidebar-width,380px)+1rem)] z-[1000] w-80 max-w-[calc(100vw-5rem)]"
          >
            <SafetyScoreCard
              lat={mapTap.lat}
              lng={mapTap.lng}
              incidents={filteredIncidents}
              onClose={() => setMapTap(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Long-press / right-click peek — read-only "what's happening here?" */}
      <AnimatePresence>
        {peekAnchor && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-3 md:bottom-16 left-3 md:left-[calc(var(--pp-map-sidebar-width,380px)+1rem)] z-[1000] w-72 max-w-[calc(100vw-5rem)]"
          >
            <LocationPeekCard
              lat={peekAnchor.lat}
              lng={peekAnchor.lng}
              incidents={incidents}
              categoryPills={CATEGORY_PILLS}
              onClose={() => setPeekAnchor(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* District Stats Card */}
      <AnimatePresence>
        {selectedDistrict && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-3 md:bottom-16 left-3 md:left-[calc(var(--pp-map-sidebar-width,380px)+1rem)] z-[1000] w-80 max-w-[calc(100vw-5rem)]"
          >
            <DistrictCard
              district={selectedDistrict.district}
              incidents={selectedDistrict.incidents}
              color={(() => {
                const DISTRICT_COLORS = [
                  "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
                  "#ec4899", "#14b8a6", "#f97316", "#06b6d4", "#a3e635",
                  "#e879f9", "#fb923c", "#34d399", "#818cf8", "#fbbf24",
                  "#f87171", "#2dd4bf", "#c084fc", "#4ade80", "#38bdf8",
                ];
                const idx = DISTRICTS.findIndex((n) => n.slug === selectedDistrict.district.slug);
                return DISTRICT_COLORS[idx >= 0 ? idx % DISTRICT_COLORS.length : 0];
              })()}
              onClose={() => setSelectedDistrict(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cluster List */}
      <AnimatePresence>
        {clusterIncidents && clusterIncidents.length > 0 && !selected && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-3 md:bottom-16 left-3 md:left-[calc(var(--pp-map-sidebar-width,380px)+1rem)] z-[1000] w-96 max-w-[calc(100vw-5rem)]"
          >
            <ClusterListPanel
              incidents={clusterIncidents}
              onSelect={(id) => { setClusterIncidentIds(null); setSelectedId(id); }}
              onClose={() => setClusterIncidentIds(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Incident Detail */}
      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-3 md:bottom-16 left-3 md:left-[calc(var(--pp-map-sidebar-width,380px)+1rem)] z-[1000] w-96 max-w-[calc(100vw-5rem)]"
          >
            <IncidentDetail
              incident={selected}
              onClose={() => setSelectedId(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      </div>{/* end map view wrapper */}

      {/* Analytics: outside map shell so parent opacity/visibility does not hide it */}
      {viewTab === "analytics" && (
        <motion.div className="absolute inset-x-0 top-0 bottom-[calc(64px+env(safe-area-inset-bottom,0px))] md:bottom-0 z-20 bg-[var(--map-bg)] overflow-y-auto">
          <div className="max-w-5xl mx-auto p-4 md:p-8">
            <AnalyticsPanel
              incidents={allIncidents}
              areaName={cityDisplayName}
              feedLabels={feedLabels}
              routeGeometry={tripGeometry ?? undefined}
              activeCats={activeCats}
              onActiveCatsChange={setActiveCats}
              onClose={() => setViewTab("map")}
            />
          </div>
        </motion.div>
      )}

      {/* ──── Feed view ──── */}
      {viewTab === "feed" && (
        <motion.div
          className="absolute inset-x-0 top-0 bottom-[calc(64px+env(safe-area-inset-bottom,0px))] md:bottom-0 flex flex-col overflow-hidden z-20"
          style={{ background: "var(--panel-bg)" }}
        >
          {/* Feed stats header */}
          <div
            className="px-5 py-3 flex items-center justify-between shrink-0"
            style={{ borderBottom: "1px solid var(--panel-border)" }}
          >
            <div className="flex items-center gap-2.5">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[11px] text-green-500 font-semibold tracking-wide">LIVE</span>
              <span className="text-[11px]" style={{ color: "var(--panel-text-muted)" }}>·</span>
              <span className="text-sm font-bold" style={{ color: "var(--panel-text)" }}>
                {filteredIncidents.length}
              </span>
              <span className="text-xs" style={{ color: "var(--panel-text-secondary)" }}>
                incidents{activeTimeLabel ? ` · ${activeTimeLabel}` : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {isPro && (
                <button
                  type="button"
                  onClick={() => setViewTab("analytics")}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium"
                  style={{ background: "var(--pp-accent-soft)", color: "var(--pp-accent)" }}
                >
                  <Activity className="w-3 h-3" />
                  {feedActiveNow} active
                </button>
              )}
              {trendPct !== 0 && (
                <div className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium ${
                  trendPct > 0 ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"
                }`}>
                  {trendPct > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {trendPct > 0 ? "+" : ""}{trendPct}%
                </div>
              )}
            </div>
          </div>

          {/* Sort toggle (Recent / Near Me) & Search */}
          <div
            className="px-3 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            style={{ borderBottom: "1px solid var(--panel-border)" }}
          >
            <div
              className="inline-flex rounded-full p-0.5 text-xs shrink-0 self-start"
              style={{
                background: "var(--panel-input-bg)",
                border: "1px solid var(--panel-border)",
              }}
              role="tablist"
              aria-label="Feed sorting"
            >
              <button
                type="button"
                role="tab"
                aria-selected={feedSortMode === "recent"}
                onClick={() => setFeedSortMode("recent")}
                className="px-3 py-1 rounded-full font-medium flex items-center gap-1.5 transition-colors"
                style={{
                  background: feedSortMode === "recent" ? "var(--pp-accent-bg)" : "transparent",
                  color: feedSortMode === "recent" ? "#3b82f6" : "var(--panel-text-muted)",
                }}
              >
                <Clock className="w-3 h-3" /> Recent
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={feedSortMode === "near"}
                onClick={requestFeedLocation}
                disabled={feedLocating}
                className="px-3 py-1 rounded-full font-medium flex items-center gap-1.5 transition-colors"
                style={{
                  background: feedSortMode === "near" ? "var(--pp-accent-bg)" : "transparent",
                  color: feedSortMode === "near" ? "#3b82f6" : "var(--panel-text-muted)",
                  opacity: feedLocating ? 0.6 : 1,
                }}
              >
                <Crosshair className={`w-3 h-3 ${feedLocating ? "animate-spin" : ""}`} /> 
                {feedLocating ? "Locating..." : "Near me"}
              </button>
            </div>

            <div className="relative flex-1 w-full max-w-sm shrink-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: "var(--panel-text-muted)" }} />
              <input
                type="text"
                placeholder="Search feed..."
                value={feedSearchQuery}
                onChange={(e) => setFeedSearchQuery(e.target.value)}
                className="w-full pl-8 pr-8 py-1.5 text-xs rounded-full transition-colors focus:outline-none"
                style={{
                  background: "var(--panel-input-bg)",
                  border: "1px solid var(--panel-border)",
                  color: "var(--panel-text)"
                }}
              />
              {feedSearchQuery && (
                <button
                  onClick={() => setFeedSearchQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2"
                >
                  <X className="w-3.5 h-3.5 hover:opacity-80 transition-opacity" style={{ color: "var(--panel-text-muted)" }} />
                </button>
              )}
            </div>
          </div>

          {/* Filter row within feed (time + category) */}
          <div
            className="px-3 py-2.5 flex flex-col gap-2.5 shrink-0"
            style={{ borderBottom: "1px solid var(--panel-border)" }}
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2 px-0.5">
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  Time window
                </span>
                {activeTimeLabel && (
                  <span className="text-[10px]" style={{ color: "var(--panel-text-secondary)" }}>
                    {activeTimeLabel}
                  </span>
                )}
              </div>
              <div
                className="flex items-center rounded-full overflow-x-auto no-scrollbar"
                style={{ background: "var(--panel-input-bg)", border: "1px solid var(--panel-border)" }}
              >
                <Clock className="w-3.5 h-3.5 ml-2.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
                {TIME_FILTERS.map((tf) => {
                  const locked = tf.pro && !isPro;
                  return (
                    <button
                      key={tf.label}
                      type="button"
                      onClick={() => {
                        if (locked) { setShowUpgrade("Extended History"); return; }
                        setTimeFilter(tf.hours);
                      }}
                      className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors relative shrink-0 ${
                        timeFilter === tf.hours ? "bg-blue-500/15 text-blue-500" : ""
                      } ${locked ? "opacity-50" : ""}`}
                      style={timeFilter !== tf.hours ? { color: locked ? "var(--panel-text-muted)" : "var(--panel-text-secondary)" } : {}}
                      title={locked ? "Pro feature · upgrade to unlock" : undefined}
                    >
                      {tf.label}
                      {locked && <Lock className="w-2.5 h-2.5 absolute -top-0.5 -right-0.5 text-purple-400" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
              <FilterPresetsBar
                activeCats={activeCats}
                timeFilterHours={timeFilter}
                onApply={(cats, hours) => {
                  setActiveCats(cats);
                  const tf = TIME_FILTERS.find((t) => t.hours === hours);
                  if (tf?.pro && !isPro) {
                    setShowUpgrade("Extended History");
                    return;
                  }
                  setTimeFilter(hours);
                }}
              />

              <button
                type="button"
                onClick={() => setActiveCats(new Set())}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[10px] font-medium transition-all shrink-0 ${
                  activeCats.size === 0 ? "bg-blue-500/15 text-blue-500 ring-1 ring-blue-500/30" : "opacity-70 hover:opacity-100"
                }`}
                style={
                  activeCats.size > 0
                    ? { background: "var(--panel-input-bg)", border: "1px solid var(--panel-border)", color: "var(--panel-text-secondary)" }
                    : { background: "var(--pp-accent-bg)", border: "1px solid var(--pp-accent-border)" }
                }
              >
                All
              </button>

              {CATEGORY_PILLS.map((pill) => {
                const Icon = pill.icon;
                const isActive = pill.cats.some((c) => activeCats.has(c));
                const count = filteredIncidents.filter((i) => (pill.cats as readonly string[]).includes(i.severity_category)).length;
                return (
                  <button
                    key={pill.label}
                    type="button"
                    onClick={() => toggleCat(pill.cats)}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[10px] font-medium transition-all shrink-0 ${
                      isActive ? "ring-1" : "opacity-70 hover:opacity-100"
                    }`}
                    style={{
                      background: isActive ? withAlpha(pill.color, 9) : "var(--panel-input-bg)",
                      border: `1px solid ${isActive ? withAlpha(pill.color, 25) : "var(--panel-border)"}`,
                      color: isActive ? pill.color : "var(--panel-text-secondary)",
                    }}
                  >
                    <Icon className="w-3 h-3" />
                    {pill.label}
                    {count > 0 && (
                      <span className="text-[10px] font-mono" style={{ opacity: isActive ? 1 : 0.5 }}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <FeedAudioMiniPlayer />

          <FeedPullRefresh
            className="flex-1"
            onRefresh={async () => {
              setFeedVisibleLimit(40);
            }}
          >
            <IncidentFeed
              incidents={visibleFeedIncidents}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId((prev) => (prev === id ? null : id));
              }}
              onViewOnMap={(id) => {
                setSelectedId(id);
                const inc = filteredIncidents.find((i) => i.id === id);
                if (inc?.lat != null && inc?.lng != null) {
                  setViewTab("map");
                  requestAnimationFrame(() => {
                    mapRef.current?.flyTo(inc.lat!, inc.lng!, 16);
                  });
                }
              }}
              showMapThumbnail
              density="immersive"
              sortMode={feedSortMode}
              userLoc={feedUserLoc}
            />
            {feedVisibleLimit < feedIncidents.length && (
              <div className="px-4 py-3 text-center">
                <button
                  type="button"
                  onClick={() => setFeedVisibleLimit((n) => n + 40)}
                  className="text-xs font-medium px-3 py-1.5 rounded-full"
                  style={{ background: "var(--panel-input-bg)", color: "var(--panel-text-secondary)" }}
                >
                  Load more
                </button>
              </div>
            )}
          </FeedPullRefresh>
        </motion.div>
      )}

      {viewTab === "ask" && (
        <motion.div
          className="absolute inset-x-0 top-0 bottom-[calc(64px+env(safe-area-inset-bottom,0px))] md:bottom-0 z-20 flex flex-col min-h-0 overflow-hidden"
          style={{ background: "var(--panel-bg)" }}
        >
          <AskPulsePanel
            citySlug={getCurrentCity().slug}
            isPro={isPro}
            authLoading={authLoading}
            onClose={() => setViewTab("map")}
            onRequestPro={() => setShowUpgrade("Ask Pulse")}
          />
        </motion.div>
      )}

      </motion.div>{/* end content area wrapper */}

      {/* Trip recap — root-level so it clears the desktop tab bar on every view. */}
      {tripRecap && (
        <TripRecapCard
          recap={tripRecap}
          historyId={tripRecapHistoryId}
          onClose={() => { setTripRecap(null); setTripRecapHistoryId(null); }}
        />
      )}

      {/* Upgrade prompt overlay */}
      <AnimatePresence>
        {showUpgrade && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
            onClick={() => setShowUpgrade(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              <UpgradePrompt
                feature={showUpgrade}
                description={
                  showUpgrade === "Ask Pulse"
                    ? "Unlock Ask Pulse for AI answers grounded in scanner-sourced incidents, plus extended history, analytics, and more."
                    : "Get extended history, analytics, safe routing, audio clips, and multi-city access."
                }
                onClose={() => setShowUpgrade(null)}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
