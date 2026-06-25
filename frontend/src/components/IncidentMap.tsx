"use client";

import {
  useEffect,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import L from "leaflet";
import "@/lib/leaflet-heat.js";
import "leaflet.markercluster";
// Side-effect: extends L.Map with rotation support (two-finger pinch-
// rotate on touch, `bearing` getter/setter, `rotate`/`touchRotate`
// map options). The plugin patches Leaflet internals via
// L.Class.include, so all existing layers (markers, polylines,
// markercluster, heat, route overlays, etc.) inherit rotation
// awareness automatically — no per-layer code changes needed.
import "leaflet-rotate";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
// Side-effect import: registers `L.maplibreGL(...)` on the leaflet
// namespace so the vector-tiles toggle can swap it in for the raster
// `L.tileLayer` we use by default. The CSS is required by MapLibre
// itself for its compass/attribution glyphs even though we don't show
// them.
import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";
import { vectorBasemapStyleUrl, isVectorTilesEnabled, subscribeVectorTiles } from "@/lib/vector-basemap";
import { SAFEST_ROUTE_ONLY_UI, type CongestionSpan } from "@/lib/routing";
import type { Incident } from "@/lib/api";
import { heatmapWeight } from "@/lib/severity";
import type { RouteData } from "@/components/RoutePanel";
import { DISTRICTS, type District, incidentsInDistrict } from "@/lib/districts";
import { districtFillsGreedy } from "@/lib/district-fill-colors";
import { useCityDistricts } from "@/hooks/useCityDistricts";
import { getCurrentCity } from "@/lib/pulse-cities";
import { spawnSnapPulse } from "@/lib/snap-pulse";

/** One colour per *category*; sub-types within a category share the same hue. */
type MonoColor = { fill: string; stroke: string; pulse: string };

const MONO: Record<string, MonoColor> = {
  gun_shots:  { fill: "#EF4444", stroke: "#991B1B", pulse: "rgba(239,68,68,0.55)" },
  gun:        { fill: "#EF4444", stroke: "#991B1B", pulse: "rgba(239,68,68,0.5)" },
  knife:      { fill: "#EF4444", stroke: "#991B1B", pulse: "rgba(239,68,68,0.5)" },
  melee:      { fill: "#EF4444", stroke: "#991B1B", pulse: "rgba(239,68,68,0.48)" },
  fist:       { fill: "#EF4444", stroke: "#991B1B", pulse: "rgba(239,68,68,0.45)" },
  syringe:    { fill: "#38BDF8", stroke: "#0369A1", pulse: "rgba(56,189,248,0.5)" },
  pill:       { fill: "#38BDF8", stroke: "#0369A1", pulse: "rgba(56,189,248,0.45)" },
  fire:       { fill: "#FB923C", stroke: "#9A3412", pulse: "rgba(251,146,60,0.5)" },
  car:        { fill: "#60A5FA", stroke: "#1E40AF", pulse: "rgba(96,165,250,0.45)" },
  robbery:    { fill: "#4ADE80", stroke: "#166534", pulse: "rgba(74,222,128,0.45)" },
  burglary:   { fill: "#FACC15", stroke: "#854D0E", pulse: "rgba(250,204,21,0.5)" },
  disorder:   { fill: "#C084FC", stroke: "#6B21A8", pulse: "rgba(192,132,252,0.45)" },
  admin:      { fill: "#94A3B8", stroke: "#334155", pulse: "rgba(148,163,184,0.4)" },
  default:    { fill: "#94A3B8", stroke: "#334155", pulse: "rgba(148,163,184,0.4)" },
};

const RE_KNIFE =
  /\b(knife|knives|stab|stabb|stabbing|stabbed|blade|machete|box\s*cutter|cutting|slash|slashed)\b/i;
const RE_GUN =
  /\b(gun|guns|shoot|shot|shots|shooting|shooter|firearm|pistol|rifle|glock|handgun|magazine|ammo|rounds?|discharged|shell\s*casings?)\b/i;

function incidentNarrative(inc: Incident): string {
  return `${inc.raw_text} ${inc.description ?? ""} ${inc.location_text ?? ""}`.toLowerCase();
}

export function resolveBlipKind(inc: Incident): string {
  const t = incidentNarrative(inc);
  const c = inc.severity_category;
  if (c === "shots_heard") return "gun_shots";
  if (c === "violent_weapon") {
    if (RE_KNIFE.test(t)) return "knife";
    if (RE_GUN.test(t)) return "gun";
    return "melee";
  }
  if (c === "violent_no_weapon") return "fist";
  if (c === "medical_priority") return "syringe";
  if (c === "medical_other") return "pill";
  if (c === "fire_hazmat") return "fire";
  if (c === "traffic_crash_injury" || c === "traffic_crash_no_injury") return "car";
  if (c === "robbery") return "robbery";
  if (c === "burglary_in_progress") return "burglary";
  if (c === "disorder") return "disorder";
  if (c === "admin_or_noise") return "admin";
  return "default";
}

function monoColor(kind: string): MonoColor {
  return MONO[kind] ?? MONO.default;
}

function gid(uid: string | number, name: string): string {
  return `ppig_${uid}_${name}`;
}


/**
 * Monochrome silhouette per sub-type.  All violence kinds share RED,
 * medical shares BLUE, etc.  Each sub-type has a unique shape.
 */
export function monoGlyphSvg(kind: string, uid: string | number): string {
  const g = (n: string) => gid(uid, n);
  const c = monoColor(kind);
  const f = c.fill;
  const s = c.stroke;

  const defs = `<defs>
    <filter id="${g("ds")}" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="1.4" flood-color="${s}" flood-opacity="0.5"/>
    </filter>
  </defs>`;

  const wrap = (body: string) =>
    `<svg viewBox="0 0 40 40" width="100%" height="100%" style="display:block" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  ${defs}
  <g filter="url(#${g("ds")})">${body}</g>
</svg>`;

  switch (kind) {
    /* ── VIOLENT (all red, different silhouettes) ─────────────── */
    case "gun":
      return wrap(`<g transform="translate(20,20)" fill="${f}" stroke="${s}" stroke-width="0.7">
        <path d="M-8 2 L-8 0 L-9 -2 L-9 -5 L6 -5 L7 -3 L12 -3 L14 -5 L15 -5 L15 -2 L13 0 L12 0 L10 2 Z"/>
        <rect x="-10" y="0" width="5" height="9" rx="0.6"/>
        <rect x="7" y="-4" width="8" height="3" rx="0.5"/>
      </g>`);

    case "gun_shots":
      return wrap(`<g transform="translate(20,20)" fill="${f}" stroke="${s}" stroke-width="0.7">
        <path d="M-8 2 L-8 0 L-9 -2 L-9 -5 L6 -5 L7 -3 L12 -3 L14 -5 L15 -5 L15 -2 L13 0 L12 0 L10 2 Z"/>
        <rect x="-10" y="0" width="5" height="9" rx="0.6"/>
        <rect x="7" y="-4" width="8" height="3" rx="0.5"/>
      </g>
      <g transform="translate(20,20)" stroke="#FFF176" stroke-width="1.6" stroke-linecap="round" fill="none" opacity="0.95">
        <line x1="13" y1="-8" x2="16" y2="-12"/>
        <line x1="16" y1="-5" x2="19" y2="-7"/>
        <line x1="15" y1="-1" x2="19" y2="0"/>
      </g>`);

    case "knife":
      return wrap(`<g transform="translate(20,19)" fill="${f}" stroke="${s}" stroke-width="0.7">
        <path d="M-1 -12 L3 -12 L4 -10 L4 4 L-1 4 Z"/>
        <rect x="-3" y="4" width="8" height="8" rx="1"/>
        <line x1="-3" y1="7" x2="5" y2="7" stroke="${s}" stroke-width="0.5"/>
      </g>`);

    case "melee":
      return wrap(`<g transform="translate(20,20) rotate(-40)" fill="${f}" stroke="${s}" stroke-width="0.7">
        <rect x="-12" y="-2" width="18" height="4" rx="1.2"/>
        <rect x="5" y="-3.5" width="5" height="7" rx="1"/>
      </g>`);

    case "fist":
      return wrap(`<g transform="translate(20,20)" fill="${f}" stroke="${s}" stroke-width="0.6">
        <ellipse cx="0" cy="2" rx="7" ry="8"/>
        <ellipse cx="-4" cy="-4" rx="3" ry="3.2"/>
        <ellipse cx="0" cy="-5.5" rx="2.8" ry="3"/>
        <ellipse cx="4" cy="-4" rx="2.8" ry="3"/>
        <ellipse cx="7" cy="-1.5" rx="2.5" ry="2.8"/>
      </g>`);

    /* ── MEDICAL (cyan / light-blue, different shapes) ──────── */
    case "syringe":
      return wrap(`<g transform="translate(20,20)" fill="${f}" stroke="${s}" stroke-width="0.6">
        <rect x="-2" y="-10" width="4" height="18" rx="0.8"/>
        <rect x="-4" y="-13" width="8" height="4" rx="0.6"/>
        <line x1="0" y1="8" x2="0" y2="13" stroke="${s}" stroke-width="1.8" stroke-linecap="round"/>
      </g>`);

    case "pill":
      return wrap(`<g transform="translate(20,20) rotate(-25)" fill="${f}" stroke="${s}" stroke-width="0.6">
        <rect x="-9" y="-4.5" width="18" height="9" rx="4.5"/>
        <line x1="0" y1="-4.5" x2="0" y2="4.5" stroke="${s}" stroke-width="0.8"/>
      </g>`);

    /* ── FIRE (orange) ──────────────────────────────────────── */
    case "fire":
      return wrap(`<g transform="translate(20,20)" fill="${f}" stroke="${s}" stroke-width="0.6">
        <path d="M0 -13 Q6 -6 3 2 Q8 -1 6 8 Q4 13 0 13 Q-4 13 -6 8 Q-8 -1 -3 2 Q-6 -6 0 -13Z"/>
      </g>`);

    /* ── TRAFFIC (blue) ─────────────────────────────────────── */
    case "car":
      return wrap(`<g transform="translate(20,21)" fill="${f}" stroke="${s}" stroke-width="0.6">
        <path d="M-12 3 L-10 -3 L10 -3 L12 3 L12 6 L-12 6 Z"/>
        <rect x="-6" y="-8" width="12" height="6" rx="1"/>
        <circle cx="-8" cy="6" r="2.5" fill="${s}"/>
        <circle cx="8" cy="6" r="2.5" fill="${s}"/>
      </g>`);

    /* ── ROBBERY (green) ────────────────────────────────────── */
    case "robbery":
      return wrap(`<g transform="translate(20,20)" fill="${f}" stroke="${s}" stroke-width="0.6">
        <path d="M-8 2 Q-8 -3 0 -6 Q8 -3 8 2 L8 9 Q8 13 0 13 Q-8 13 -8 9 Z"/>
        <path d="M-4 -6 Q0 -10 4 -6" fill="none" stroke="${s}" stroke-width="1.2" stroke-linecap="round"/>
        <text x="0" y="7" text-anchor="middle" font-size="11" font-weight="800" fill="${s}" stroke="none" font-family="system-ui,sans-serif">$</text>
      </g>`);

    /* ── BURGLARY (yellow) ──────────────────────────────────── */
    case "burglary":
      return wrap(`<g transform="translate(20,19)" fill="${f}" stroke="${s}" stroke-width="0.6">
        <rect x="-7" y="-10" width="14" height="20" rx="1"/>
        <circle cx="4" cy="0" r="1.3" fill="${s}"/>
        <path d="M-9.5 -4 L-7 -4 L-7 10 L-9.5 10 Q-11 3 -9.5 -4Z"/>
      </g>`);

    /* ── DISORDER (purple) ──────────────────────────────────── */
    case "disorder":
      return wrap(`<g transform="translate(20,20)" fill="${f}" stroke="${s}" stroke-width="0.6">
        <rect x="-7" y="-6" width="9" height="12" rx="1.2"/>
        <path d="M2 -4 Q8 -7 11 0 Q8 5 2 3" fill="none" stroke="${f}" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M2 1 Q9 -1 12 3" fill="none" stroke="${f}" stroke-width="1.3" stroke-linecap="round" opacity="0.7"/>
      </g>`);

    /* ── ADMIN / NOISE (grey) ───────────────────────────────── */
    case "admin":
      return wrap(`<g transform="translate(20,20)" fill="none" stroke="${f}" stroke-width="1.8" stroke-linecap="round">
        <path d="M-12 -1 Q-4 -6 4 -1 Q12 4 20 -1"/>
        <path d="M-12 4 Q-4 -1 4 4 Q12 9 20 4"/>
      </g>`);

    /* ── DEFAULT (diamond) ──────────────────────────────────── */
    default:
      return wrap(`<g transform="translate(20,20)" fill="${f}" stroke="${s}" stroke-width="0.6">
        <path d="M0 -11 L8 0 L0 11 L-8 0 Z"/>
      </g>`);
  }
}

/** Incident marker: monochrome glyph; zoom scaling via CSS custom property on the map container. */
function createIncidentGlyphIcon(
  inc: Incident,
  uid: number,
  wEff: number,
  isHighSev: boolean,
  greyed: boolean
): L.DivIcon {
  const kind = resolveBlipKind(inc);
  const base = 18;
  const box = 22;
  const half = 11;
  const opacity = greyed ? 0.54 : 0.92;
  const filt = greyed
    ? "filter:saturate(0.65) brightness(0.9) drop-shadow(0 1px 2px rgba(0,0,0,0.35));"
    : "filter:drop-shadow(0 1px 3px rgba(0,0,0,0.5));";
  const svg = monoGlyphSvg(kind, uid);
  return L.divIcon({
    className: "pp-incident-marker",
    iconSize: [box, box],
    iconAnchor: [half, half],
    html: `<div class="pp-incident-marker-inner" style="position:relative;width:${box}px;height:${box}px;box-sizing:border-box;">
      <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:${base}px;height:${base}px;opacity:${opacity};${filt}">${svg}</div>
    </div>`,
  });
}

declare module "leaflet" {
  function heatLayer(
    latlngs: [number, number, number][],
    options?: Record<string, unknown>
  ): L.Layer;
}

export interface MapHandle {
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  /** Fly back to default city overview. */
  resetView: () => void;
  /** Cheap pan-only motion (no zoom change). Used by follow-me mode so we
   *  don't fight the user with constant flyTo zooms. */
  panTo: (lat: number, lng: number) => void;
  /** Current viewport bounds. Returns null before the map has mounted.
   *  Used to detect when an incoming incident is off-screen so we can
   *  surface a "fly here" alert. */
  getBounds: () => { north: number; south: number; east: number; west: number } | null;
  /** Current map center. */
  getCenter: () => { lat: number; lng: number } | null;
  /** Raw DOM element wrapping the Leaflet map. Returned so other
   *  components can rasterize the visible map (e.g. share-as-image)
   *  without reaching into the imperative handle for everything. */
  getContainer: () => HTMLElement | null;
}

export interface WaypointPin {
  label: string;
  lat: number;
  lng: number;
  color: string;
  glowColor: string;
}

interface Props {
  incidents: Incident[];
  selectedId: string | null;
  onSelectIncident: (id: string) => void;
  routes?: RouteData | null;
  onMapTap?: (lat: number, lng: number) => void;
  mapTapActive?: boolean;
  userLocation?: { lat: number; lng: number } | null;
  tripRouteGeometry?: [number, number][] | null;
  /** Congestion spans (index ranges into tripRouteGeometry) for the active
   *  trip's route, so the live nav line can paint amber/red on the road ahead. */
  tripRouteCongestion?: CongestionSpan[] | null;
  previewOrigin?: { lat: number; lng: number } | null;
  previewDest?: { lat: number; lng: number } | null;
  previewWaypoints?: WaypointPin[] | null;
  /** "You tapped a search result" pin — a Google-Maps-style red
   *  lollipop dropped at the place's coords with a fly-to. Rendered
   *  in its own layer, distinct from the A/B routing preview pins so
   *  the place card can show its marker without claiming the
   *  routing UI. Set to null to remove. */
  searchedPlace?: { lat: number; lng: number; name?: string } | null;
  tripMode?: string | null;
  heatmapEnabled?: boolean;
  /** When set to an integer 0..23, the heatmap downweights incidents whose
   *  reported_at hour-of-day differs from the focus hour by more than ±1h
   *  (wrapping at midnight). Used by the "This hour's hotspots" overlay
   *  to surface time-of-day patterns from the long backfill. */
  todHourFocus?: number | null;
  isDark?: boolean;
  onTripProgress?: (progress: number) => void;
  liveTripGps?: boolean;
  timeFilterHours?: number;
  /** Demo: vivid heat + pulse + radiating vehicle / user marker (e.g. route sim checkbox). */
  heatmapDemoBoost?: boolean;
  districtsEnabled?: boolean;
  onDistrictClick?: (district: District, incidents: Incident[]) => void;
  onClusterClick?: (incidentIds: string[]) => void;
  /** Long-press / right-click on the map. Currently wired to the
   *  LocationPeekCard; no sticky marker is rendered here. */
  onLongPress?: (lat: number, lng: number) => void;
  /** Sticky purple "Parked here" pin from the parked-pin store. Persists
   *  across reloads (24h TTL). */
  parkedPin?: { lat: number; lng: number } | null;
  /** Debounced (~250ms) callback fired after pan/zoom with the current map
   *  center + zoom (e.g. Safety-POI refetch in `page.tsx`). */
  onMapMove?: (lat: number, lng: number, zoom: number) => void;
  /** Compass heading in degrees (0=N, clockwise). Renders a directional
   *  cone behind the user marker. Null/undefined → no cone. */
  userHeading?: number | null;
  /** Basemap tile style. Defaults to "auto" (follows the active theme). */
  basemapStyle?: BasemapStyle;
  /** Sequence of points dropped via the measurement tool. When
   *  non-null, IncidentMap renders a dashed polyline + numbered
   *  vertex markers in a dedicated layer. The host (page.tsx) owns
   *  the array; tapping the map while measure mode is on appends a
   *  new point via the standard onMapTap callback. */
  measurePoints?: [number, number][] | null;
  /** Sequence of points dropped via the perimeter tool. When
   *  non-null, forms a closed polygon on the map. */
  perimeterPoints?: [number, number][] | null;
  /** Read-only polyline rendered when the user opens a shared-trip link
   *  (`?trip=<token>`). Visually distinct from `tripRouteGeometry` to
   *  signal that it's someone *else's* route, not the viewer's. */
  sharedTripGeometry?: [number, number][] | null;
  /** Optional destination marker for the shared trip. Rendered with the
   *  standard red end-pin so it visually matches a normal `endPin`. */
  sharedTripDestination?: [number, number] | null;
  /** Fires once when the user drags the map (manual gesture). Used by
   *  the follow-me logic to disable auto-recenter when the rider takes
   *  manual control. Does not fire for programmatic panTo(). */
  onUserDrag?: () => void;
  /** When false, defer expensive incident/heatmap relayers while another
   *  surface (feed, analytics) is foregrounded. */
  layersActive?: boolean;
  /** TomTom traffic overlay toggled from the Layers menu. Tiles are
   *  proxied through Next so the API key never reaches the browser. */
  trafficLayerEnabled?: boolean;
  /** Persistent safety-POI overlay (hospitals/police/fire). Rendered as
   *  a separate Leaflet layer-group so toggling it doesn't disturb the
   *  incident-marker cluster. Page-level fetcher hands us a pre-filtered
   *  list keyed by viewport bounds. */
  safetyPois?: Array<{
    id: string;
    name: string;
    category: "hospital" | "police" | "fire_station";
    lat: number;
    lng: number;
  }> | null;
  /** Convenience-POI overlay (gas, food, EV charging, ATM, etc).
   *  Rendered via a parallel layer group so its toggle is independent
   *  from the safety-POI layer and so the visual language can stay
   *  deliberately distinct. */
  nearbyPois?: Array<{
    id: string;
    name: string;
    category: "fuel" | "food" | "coffee" | "atm" | "parking" | "charging_station" | "toilets";
    lat: number;
    lng: number;
  }> | null;
  /** Optional render of the user's saved places (Home/Work/Favorite/Custom)
   *  as map markers. Off by default at the parent level — opt-in via the
   *  Layers menu. Click fires `onSavedPlaceClick` with the underlying
   *  destination for parent-driven actions (fly-to, directions, etc.). */
  savedPlaces?: Array<{
    id: string;
    name: string;
    lat: number;
    lng: number;
    category: "home" | "work" | "favorite" | "custom";
    /** Hex accent for custom-list-bound entries. Falls back to the
     *  built-in category color when unset. */
    accentColor?: string;
  }> | null;
  onSavedPlaceClick?: (id: string, lat: number, lng: number, name: string) => void;
}

function distToSegmentKm(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(a[0]), lng1 = toRad(a[1]);
  const lat2 = toRad(b[0]), lng2 = toRad(b[1]);
  const latP = toRad(p[0]), lngP = toRad(p[1]);

  const dAP = Math.acos(
    Math.sin(lat1) * Math.sin(latP) +
    Math.cos(lat1) * Math.cos(latP) * Math.cos(lngP - lng1)
  ) * R;
  const dAB = Math.acos(
    Math.sin(lat1) * Math.sin(lat2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1)
  ) * R;

  if (dAB === 0) return dAP;

  const bearAB = Math.atan2(
    Math.sin(lng2 - lng1) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1)
  );
  const bearAP = Math.atan2(
    Math.sin(lngP - lng1) * Math.cos(latP),
    Math.cos(lat1) * Math.sin(latP) - Math.sin(lat1) * Math.cos(latP) * Math.cos(lngP - lng1)
  );

  const crossTrack = Math.abs(Math.asin(Math.sin(dAP / R) * Math.sin(bearAP - bearAB)) * R);
  const alongTrack = Math.acos(Math.cos(dAP / R) / Math.cos(crossTrack / R)) * R;

  if (alongTrack < 0) return dAP;
  if (alongTrack > dAB) {
    const dBP = Math.acos(
      Math.sin(lat2) * Math.sin(latP) +
      Math.cos(lat2) * Math.cos(latP) * Math.cos(lngP - lng2)
    ) * R;
    return dBP;
  }
  return crossTrack;
}

function minDistToRouteKm(
  point: [number, number],
  route: [number, number][],
  sampleEvery = 5
): number {
  let minDist = Infinity;
  for (let i = 0; i < route.length - 1; i += sampleEvery) {
    const j = Math.min(i + sampleEvery, route.length - 1);
    const d = distToSegmentKm(point, route[i], route[j]);
    if (d < minDist) minDist = d;
    if (minDist < 0.2) return minDist;
  }
  return minDist;
}

function haversineKmPair(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLat = lat2 - lat1;
  const dLng = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * (2 * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Initial bearing from A→B in degrees (0 = north, 90 = east). */
function bearingDegrees(a: [number, number], b: [number, number]): number {
  const φ1 = (a[0] * Math.PI) / 180;
  const φ2 = (b[0] * Math.PI) / 180;
  const Δλ = ((b[1] - a[1]) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** CSS rotation added to geographic bearing so sprite “forward” aligns with the route (same for all 3D sprites). */
const TRANSPORT_HEADING_OFFSET = 180;

function setTransportMarkerHeading(marker: L.Marker, bearingDeg: number) {
  const el = marker.getElement()?.querySelector(".pp-transport-heading-rot");
  if (el instanceof HTMLElement) {
    const css = (bearingDeg + TRANSPORT_HEADING_OFFSET + 360) % 360;
    el.style.transform = `rotate(${css}deg)`;
  }
}

/** Closest point on one segment; t ∈ [0,1] along A→B (lat/lng linearization, fine for city scale). */
function closestPointOnSegmentLL(
  plat: number,
  plng: number,
  alat: number,
  alng: number,
  blat: number,
  blng: number
): { point: [number, number]; t: number } {
  const dlat = blat - alat;
  const dlng = blng - alng;
  const len2 = dlat * dlat + dlng * dlng;
  if (len2 < 1e-18) return { point: [alat, alng], t: 0 };
  let t = ((plat - alat) * dlat + (plng - alng) * dlng) / len2;
  t = Math.max(0, Math.min(1, t));
  return { point: [alat + t * dlat, alng + t * dlng], t };
}

/** Distance along polyline to closest point to (lat,lng), plus total route length. */
function closestDistAlongOnRoute(
  route: [number, number][],
  lat: number,
  lng: number
): { distAlong: number; totalLen: number } {
  let totalLen = 0;
  const segLens: number[] = [];
  for (let i = 0; i < route.length - 1; i++) {
    const L = haversineKmPair(route[i], route[i + 1]);
    segLens.push(L);
    totalLen += L;
  }

  let bestDistAlong = 0;
  let bestPerp = Infinity;
  let acc = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const { point, t } = closestPointOnSegmentLL(lat, lng, a[0], a[1], b[0], b[1]);
    const perp = haversineKmPair([lat, lng], point);
    if (perp < bestPerp) {
      bestPerp = perp;
      bestDistAlong = acc + t * segLens[i];
    }
    acc += segLens[i];
  }
  return { distAlong: bestDistAlong, totalLen };
}

function splitRouteAtDistance(
  route: [number, number][],
  distAlongKm: number
): { traveled: [number, number][]; remaining: [number, number][]; marker: [number, number] } {
  const p0 = route[0];
  if (route.length < 2 || !p0) {
    const p: [number, number] = p0 ?? [0, 0];
    return { traveled: [p], remaining: [p], marker: p };
  }

  let totalLen = 0;
  for (let i = 0; i < route.length - 1; i++) {
    totalLen += haversineKmPair(route[i], route[i + 1]);
  }

  if (distAlongKm <= 0) {
    return { traveled: [route[0]], remaining: [...route], marker: route[0] };
  }
  if (distAlongKm >= totalLen - 1e-9) {
    const last = route[route.length - 1];
    return { traveled: [...route], remaining: [last], marker: last };
  }

  let acc = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const segLen = haversineKmPair(a, b);
    if (acc + segLen >= distAlongKm) {
      const t = segLen < 1e-12 ? 1 : (distAlongKm - acc) / segLen;
      const tClamped = Math.max(0, Math.min(1, t));
      const marker: [number, number] = [
        a[0] + tClamped * (b[0] - a[0]),
        a[1] + tClamped * (b[1] - a[1]),
      ];
      const traveled: [number, number][] = [...route.slice(0, i + 1)];
      traveled.push(marker);
      const tail = route.slice(i + 1);
      const remaining: [number, number][] =
        haversineKmPair(marker, tail[0]) < 0.02 ? [...tail] : [marker, ...tail];
      return { traveled, remaining, marker };
    }
    acc += segLen;
  }

  const last = route[route.length - 1];
  return { traveled: [...route], remaining: [last], marker: last };
}


/** Route start / end / via: plain round dots (A/B are color-only); other labels show inside a slightly larger dot. */
/** Google-Maps-style red lollipop pin, used to mark a place the user
 *  picked from search. Anchored at the bottom tip so the pin point
 *  sits exactly on the coords. The SVG is intentionally chunky (38x48)
 *  so it reads at thumbnail size on a phone screen — the existing
 *  A/B dot icons (12-22px) get lost against the dark basemap. */
function createSearchedPlacePinIcon(): L.DivIcon {
  const w = 38;
  const h = 48;
  return L.divIcon({
    className: "pp-searched-place-pin",
    iconSize: [w, h],
    iconAnchor: [w / 2, h - 2],
    popupAnchor: [0, -h + 8],
    html: `<svg viewBox="0 0 38 48" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;filter:drop-shadow(0 4px 6px rgba(0,0,0,0.45));">
  <defs>
    <radialGradient id="pp-place-pin-grad" cx="0.5" cy="0.32" r="0.7">
      <stop offset="0" stop-color="#fca5a5"/>
      <stop offset="0.55" stop-color="#ef4444"/>
      <stop offset="1" stop-color="#b91c1c"/>
    </radialGradient>
  </defs>
  <ellipse cx="19" cy="46" rx="6" ry="1.3" fill="rgba(0,0,0,0.45)"/>
  <path d="M19 1.6 C10.2 1.6 3.2 8.4 3.2 16.4 C3.2 28.6 19 45.6 19 45.6 C19 45.6 34.8 28.6 34.8 16.4 C34.8 8.4 27.8 1.6 19 1.6 Z" fill="url(#pp-place-pin-grad)" stroke="rgba(127,29,29,0.95)" stroke-width="1.4"/>
  <circle cx="19" cy="16.2" r="6" fill="rgba(255,255,255,0.97)"/>
  <circle cx="19" cy="16.2" r="3.6" fill="#dc2626"/>
</svg>`,
  });
}

function createEndpointDotIcon(label: string, bgColor: string, glowColor: string): L.DivIcon {
  const plainAB = label === "A" || label === "B";
  const size = plainAB ? 14 : 22;
  const half = size / 2;
  const safe = label.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"
  );
  const labelHtml = plainAB
    ? ""
    : `<span style="font-size:11px;font-weight:800;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1">${safe}</span>`;
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [half, half],
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bgColor};border:2px solid rgba(255,255,255,0.95);box-shadow:0 0 0 4px ${glowColor},0 2px 10px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;">${labelHtml}</div>`,
  });
}

/** “You are here” — standing 3D-style figure (green shirt); ids scoped for single user marker. */
function userLocationHuman3dSvg(): string {
  return `<svg viewBox="0 0 48 48" width="40" height="40" style="display:block" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="pp-user-skin" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fef3c7"/>
      <stop offset="1" stop-color="#d97706"/>
    </linearGradient>
    <linearGradient id="pp-user-shirt" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#bbf7d0"/>
      <stop offset="0.5" stop-color="#22c55e"/>
      <stop offset="1" stop-color="#14532d"/>
    </linearGradient>
    <linearGradient id="pp-user-pants" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#94a3b8"/>
      <stop offset="1" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <ellipse cx="24" cy="41" rx="14" ry="4" fill="rgba(0,0,0,0.3)"/>
  <circle cx="24" cy="22" r="15" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="1.8" opacity="0.95"/>
  <g transform="translate(24,20)">
    <circle cx="0" cy="-12" r="5.5" fill="url(#pp-user-skin)" stroke="#92400e" stroke-width="1"/>
    <path d="M-6 -5.5 Q-7 4 -5.5 12 L-3.5 16 L3.5 16 L5.5 12 Q7 4 6 -5.5 Q0 -8 -6 -5.5Z"
      fill="url(#pp-user-shirt)" stroke="#14532d" stroke-width="1"/>
    <path d="M-4.5 12 L-5 19.5 L-1 21 L0 15.5" fill="url(#pp-user-pants)" stroke="#1e293b" stroke-width="0.7"/>
    <path d="M4.5 12 L5 19.5 L1 21 L0 15.5" fill="url(#pp-user-pants)" stroke="#1e293b" stroke-width="0.7"/>
    <ellipse cx="-7.5" cy="1.5" rx="2.4" ry="2.1" fill="url(#pp-user-skin)" opacity="0.95"/>
    <ellipse cx="7.5" cy="1.5" rx="2.4" ry="2.1" fill="url(#pp-user-skin)" opacity="0.95"/>
  </g>
</svg>`;
}

/** SVG cone rendered behind the user marker showing the device's facing
 *  direction (0=N, clockwise). The cone is wedge-shaped with a soft fade —
 *  same affordance as Google Maps' blue-dot arc. */
function userHeadingConeSvg(headingDeg: number): string {
  return `<div class="pp-user-heading-cone" style="position:absolute;left:50%;top:50%;width:120px;height:120px;margin:-60px 0 0 -60px;transform:rotate(${headingDeg}deg);transform-origin:50% 50%;pointer-events:none;z-index:1;transition:transform 180ms cubic-bezier(.2,.7,.2,1);">
    <svg viewBox="-60 -60 120 120" width="120" height="120" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="pp-cone-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="rgba(74,222,128,0.95)" />
          <stop offset="55%" stop-color="rgba(34,197,94,0.45)" />
          <stop offset="100%" stop-color="rgba(34,197,94,0)" />
        </radialGradient>
      </defs>
      <path d="M0,0 L-22,-58 Q0,-66 22,-58 Z" fill="url(#pp-cone-grad)" />
    </svg>
  </div>`;
}

function createUserIcon(radiate = false, heading: number | null = null): L.DivIcon {
  const human = userLocationHuman3dSvg();
  const halo = `<div style="position:absolute;left:50%;top:56%;transform:translate(-50%,-50%);width:50px;height:50px;border-radius:50%;background:radial-gradient(circle,rgba(34,197,94,0.4) 0%,transparent 68%);pointer-events:none;z-index:2;"></div>`;
  const cone = heading != null ? userHeadingConeSvg(heading) : "";
  const core = `<div style="position:relative;width:56px;height:56px;display:flex;align-items:center;justify-content:center;">
      ${cone}
      ${halo}
      <div style="position:relative;z-index:3;transform:translateY(-3px);filter:drop-shadow(0 5px 10px rgba(22,101,52,0.45));">${human}</div>
    </div>`;
  const demoGlow = `<div style="position:absolute;left:50%;top:50%;width:60px;height:60px;margin:-30px 0 0 -30px;border-radius:50%;background:radial-gradient(circle,rgba(74,222,128,0.45) 0%,rgba(34,197,94,0.14) 50%,transparent 72%);pointer-events:none;"></div>`;

  if (!radiate) {
    return L.divIcon({
      className: "",
      iconSize: [56, 56],
      iconAnchor: [28, 50],
      html: core,
    });
  }
  return L.divIcon({
    className: "",
    iconSize: [64, 64],
    iconAnchor: [32, 58],
    html: `
      <div style="position:relative;width:64px;height:64px;display:flex;align-items:center;justify-content:center;">
        ${demoGlow}
        ${core}
      </div>`,
  });
}

/** Live-trip marker: one simple forward arrow for every travel mode. */
function transportForwardArrowSvg(): string {
  return `<svg viewBox="0 0 48 48" width="34" height="34" style="display:block" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="pp-trip-arrow-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ecfeff"/>
      <stop offset="0.42" stop-color="#38bdf8"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
    <linearGradient id="pp-trip-arrow-edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#cffafe"/>
      <stop offset="1" stop-color="#1e40af"/>
    </linearGradient>
  </defs>
  <ellipse cx="24" cy="40.5" rx="13" ry="4" fill="rgba(0,0,0,0.28)"/>
  <path
    d="M24 6.5 L38 38.5 Q38.8 40.8 36.4 39.8 L24 34.2 L11.6 39.8 Q9.2 40.8 10 38.5 Z"
    fill="url(#pp-trip-arrow-fill)"
    stroke="url(#pp-trip-arrow-edge)"
    stroke-width="1.6"
    stroke-linejoin="round"
  />
  <path d="M24 11.5 L24 30.5" stroke="rgba(255,255,255,0.62)" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M19.5 35.8 L24 33.8 L28.5 35.8" fill="none" stroke="rgba(15,23,42,0.22)" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;
}

const TRIP_FORWARD_ARROW_SVG = transportForwardArrowSvg();

const TRIP_MODES_3D: Record<string, string> = {
  "foot-walking": TRIP_FORWARD_ARROW_SVG,
  "cycling-regular": TRIP_FORWARD_ARROW_SVG,
  "driving-car": TRIP_FORWARD_ARROW_SVG,
  wheelchair: TRIP_FORWARD_ARROW_SVG,
  "transit-train": TRIP_FORWARD_ARROW_SVG,
  "transit-subway": TRIP_FORWARD_ARROW_SVG,
};

type TripVisualStyle = {
  remainingColor: string;
  traveledColor: string;
  glowColor: string;
  remainingWeight: number;
  traveledWeight: number;
  glowWeight: number;
  glowOpacity: number;
  dashArray?: string;
  guideColor?: string;
  guideWeight?: number;
  guideDashArray?: string;
};

function tripVisualStyle(mode: string | null | undefined): TripVisualStyle {
  switch (mode) {
    case "cycling-regular":
      return {
        remainingColor: "#0891b2",
        traveledColor: "#2563eb",
        glowColor: "#22d3ee",
        remainingWeight: 5,
        traveledWeight: 5,
        glowWeight: 15,
        glowOpacity: 0.16,
        guideColor: "#cffafe",
        guideWeight: 2.5,
        guideDashArray: "1 12",
      };
    case "foot-walking":
      return {
        remainingColor: "#8b5cf6",
        traveledColor: "#a78bfa",
        glowColor: "#c4b5fd",
        remainingWeight: 5,
        traveledWeight: 5,
        glowWeight: 14,
        glowOpacity: 0.15,
        dashArray: "10 10",
      };
    case "driving-car":
    default:
      return {
        remainingColor: "#22c55e",
        traveledColor: "#3b82f6",
        glowColor: "#22c55e",
        remainingWeight: 6,
        traveledWeight: 6,
        glowWeight: 16,
        glowOpacity: 0.12,
      };
  }
}

function tripModeUses3dHeading(mode: string | null | undefined): boolean {
  return mode != null && Object.prototype.hasOwnProperty.call(TRIP_MODES_3D, mode);
}

function createTransportIcon(mode: string, radiate = false): L.DivIcon {
  const resolvedMode = Object.prototype.hasOwnProperty.call(TRIP_MODES_3D, mode)
    ? mode
    : "foot-walking";
  const svg = TRIP_MODES_3D[resolvedMode];

  const softHalo = `<div style="position:absolute;left:50%;top:54%;transform:translate(-50%,-50%);width:44px;height:44px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,0.28) 0%,transparent 68%);pointer-events:none;"></div>`;

  const core = `<div style="position:relative;width:48px;height:48px;display:flex;align-items:center;justify-content:center;">
        ${softHalo}
        <div style="position:relative;z-index:2;transform:translateY(-1px);">
          <div class="pp-transport-heading-rot" style="position:relative;filter:drop-shadow(0 4px 6px rgba(0,0,0,0.45));transform-origin:center center;transition:transform 0.2s ease-out;">${svg}</div>
        </div>
      </div>`;

  if (!radiate) {
    return L.divIcon({
      className: "",
      iconSize: [48, 48],
      iconAnchor: [24, 24],
      html: core,
    });
  }

  const staticDemoGlow = `<div style="position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;background:radial-gradient(circle,rgba(96,165,250,0.35) 0%,rgba(59,130,246,0.12) 45%,transparent 72%);pointer-events:none;"></div>`;

  return L.divIcon({
    className: "",
    iconSize: [56, 56],
    iconAnchor: [28, 28],
    html: `
      <div style="position:relative;width:56px;height:56px;display:flex;align-items:center;justify-content:center;">
        ${staticDemoGlow}
        ${core}
      </div>`,
  });
}

const TRIP_PROXIMITY_KM = 1.0;

/** Parse Google-Maps-style URL hash `#zoom/lat/lng` (e.g. `#15/39.952/-75.165`). */
function parseHashView(): { zoom: number; lat: number; lng: number } | null {
  if (typeof window === "undefined") return null;
  const m = /^#(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(window.location.hash);
  if (!m) return null;
  const zoom = parseFloat(m[1]);
  const lat = parseFloat(m[2]);
  const lng = parseFloat(m[3]);
  if (!Number.isFinite(zoom) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (zoom < 1 || zoom > 22 || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { zoom, lat, lng };
}

function formatHashView(zoom: number, lat: number, lng: number): string {
  return `#${zoom.toFixed(zoom < 14 ? 0 : 1)}/${lat.toFixed(4)}/${lng.toFixed(4)}`;
}

function latLngTupleSignature(point: [number, number] | null | undefined): string {
  if (!point) return "none";
  return `${point[0].toFixed(5)},${point[1].toFixed(5)}`;
}

function pointSignature(point: { lat: number; lng: number } | null | undefined): string {
  if (!point) return "none";
  return `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

function geometrySignature(geometry: [number, number][] | null | undefined): string {
  if (!geometry || geometry.length === 0) return "none";
  const step = Math.max(1, Math.floor(geometry.length / 24));
  const pieces: string[] = [];
  for (let i = 0; i < geometry.length; i += step) {
    pieces.push(latLngTupleSignature(geometry[i]));
  }
  const last = geometry[geometry.length - 1];
  const lastSig = latLngTupleSignature(last);
  if (pieces[pieces.length - 1] !== lastSig) pieces.push(lastSig);
  return `${geometry.length}:${pieces.join("|")}`;
}

function waypointSignature(waypoints: WaypointPin[] | null | undefined): string {
  if (!waypoints || waypoints.length === 0) return "none";
  return waypoints
    .map((w) => `${w.label}:${w.lat.toFixed(5)},${w.lng.toFixed(5)}:${w.color}`)
    .join("|");
}

function routeContextSignature(
  previewOrigin: { lat: number; lng: number } | null | undefined,
  previewDest: { lat: number; lng: number } | null | undefined,
  previewWaypoints: WaypointPin[] | null | undefined,
  primaryGeometry: [number, number][] | null | undefined
): string | null {
  if (previewWaypoints && previewWaypoints.length > 0) {
    // The first waypoint is commonly "Your location" and can drift with
    // GPS. Fit the map to a route context when the destination/via stops
    // change, not when the origin jitters a meter or two.
    const stableWaypoints =
      previewWaypoints.length > 1 ? previewWaypoints.slice(1) : previewWaypoints;
    return `waypoints:${waypointSignature(stableWaypoints)}`;
  }
  if (previewDest) {
    return `dest:${pointSignature(previewDest)}`;
  }
  if (previewOrigin) {
    return `origin:${pointSignature(previewOrigin)}`;
  }
  if (primaryGeometry && primaryGeometry.length >= 2) {
    return `geom:${latLngTupleSignature(primaryGeometry[0])}>${latLngTupleSignature(primaryGeometry[primaryGeometry.length - 1])}`;
  }
  return null;
}

function routeLayerSignature(
  routes: RouteData,
  previewWaypoints: WaypointPin[] | null | undefined
): string {
  const avoidSig = routes.avoidZones
    .map((z) => `${latLngTupleSignature(z.center)}:${Math.round(z.radiusM)}`)
    .join("|");
  const chosenFeatures = routes.chosen?.avoidedFeatures?.join(",") ?? "";
  return [
    `normal:${geometrySignature(routes.normal?.geometry)}`,
    `safe:${geometrySignature(routes.safe?.geometry)}`,
    `chosen:${geometrySignature(routes.chosen?.geometry)}:${routes.chosen?.isSafe ? 1 : 0}:${chosenFeatures}`,
    `avoid:${avoidSig}`,
    `wps:${waypointSignature(previewWaypoints)}`,
  ].join("||");
}

const DARK_TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const LIGHT_TILES = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const POSITRON_TILES = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const STREETS_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export type BasemapStyle = "auto" | "dark" | "voyager" | "positron" | "streets";

function basemapUrl(style: BasemapStyle, isDark: boolean): string {
  switch (style) {
    case "dark":     return DARK_TILES;
    case "voyager":  return LIGHT_TILES;
    case "positron": return POSITRON_TILES;
    case "streets":  return STREETS_TILES;
    case "auto":
    default:         return isDark ? DARK_TILES : LIGHT_TILES;
  }
}

function basemapAttribution(style: BasemapStyle): string {
  if (style === "streets") {
    return '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  }
  return '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>';
}

function isMobileViewport(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 767px)").matches;
}

function incidentMarkerSignature(
  inc: Incident,
  tripRouteGeometry: [number, number][] | null | undefined
): string {
  let greyed = false;
  if (tripRouteGeometry && tripRouteGeometry.length >= 2 && inc.lat != null && inc.lng != null) {
    greyed = minDistToRouteKm([inc.lat, inc.lng], tripRouteGeometry) > TRIP_PROXIMITY_KM;
  }
  return `${inc.id}|${inc.lat}|${inc.lng}|${greyed ? 1 : 0}|${inc.severity_category}|${Math.round(inc.w_eff * 100)}`;
}

type TripLiveLayers = {
  marker: L.Marker | null;
  traveled: L.Polyline;
  remaining: L.Polyline;
  remainingGlow: L.Polyline;
  guide?: L.Polyline;
};

type IncidentMarker = L.Marker & { _ppIncidentId?: string };
type ClusterClickEvent = L.LeafletEvent & { layer: L.MarkerCluster };

const IncidentMap = forwardRef<MapHandle, Props>(function IncidentMap(
  {
    incidents,
    selectedId,
    onSelectIncident,
    routes,
    onMapTap,
    mapTapActive = false,
    userLocation,
    tripRouteGeometry,
    tripRouteCongestion,
    previewOrigin,
    previewDest,
    previewWaypoints,
    tripMode,
    heatmapEnabled = true,
    todHourFocus = null,
    isDark = true,
    onTripProgress,
    liveTripGps = false,
    timeFilterHours = 0,
    heatmapDemoBoost = false,
    districtsEnabled = false,
    onDistrictClick,
    onClusterClick,
    onLongPress,
    parkedPin = null,
    onMapMove,
    userHeading,
    basemapStyle = "auto",
    sharedTripGeometry,
    sharedTripDestination,
    onUserDrag,
    safetyPois = null,
    nearbyPois = null,
    savedPlaces = null,
    onSavedPlaceClick,
    measurePoints = null,
    perimeterPoints = null,
    layersActive = true,
    trafficLayerEnabled = false,
    searchedPlace = null,
  },
  ref
) {
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.MarkerClusterGroup | null>(null);
  const incidentMarkersRef = useRef<Map<string, { marker: L.Marker; signature: string }>>(new Map());
  const mapInteractingRef = useRef(false);
  const pendingIncidentSyncRef = useRef(false);
  const incidentSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueIncidentSyncRef = useRef<(delay?: number) => void>(() => {});
  const incidentsRef = useRef(incidents);
  incidentsRef.current = incidents;
  const heatRef = useRef<L.Layer | null>(null);
  const heatPulseRafRef = useRef<number | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const lastRouteRenderSigRef = useRef<string | null>(null);
  const lastRouteContextSigRef = useRef<string | null>(null);
  const lastRouteFitContextSigRef = useRef<string | null>(null);
  const safetyPoiLayerRef = useRef<L.LayerGroup | null>(null);
  const nearbyPoiLayerRef = useRef<L.LayerGroup | null>(null);
  const savedPlacesLayerRef = useRef<L.LayerGroup | null>(null);
  const searchedPlaceLayerRef = useRef<L.LayerGroup | null>(null);
  /** Coords of the place we last flew to for a search result — used
   *  to skip redundant flyTo calls when React re-renders with the
   *  same selection (Overpass / ETA fetches inside the place card
   *  cause parent state churn that would otherwise re-fly the map
   *  on every tick). */
  const searchedPlaceFlyRef = useRef<{ lat: number; lng: number } | null>(null);
  const userAvoidLayerRef = useRef<L.LayerGroup | null>(null);
  const measureLayerRef = useRef<L.LayerGroup | null>(null);
  const perimeterLayerRef = useRef<L.LayerGroup | null>(null);
  // Latest click handler — kept in a ref so the layer effect can stay
  // dependent only on `savedPlaces` and not re-create markers every
  // time the parent rebinds its callback.
  const onSavedPlaceClickRef = useRef(onSavedPlaceClick);
  onSavedPlaceClickRef.current = onSavedPlaceClick;
  const userMarkerRef = useRef<L.Marker | null>(null);
  const previewLayerRef = useRef<L.LayerGroup | null>(null);
  const transportMarkerRef = useRef<L.Marker | null>(null);
  const animFrameRef = useRef<number | null>(null);
  /** Either the raster L.TileLayer or — when the user enabled vector
   *  tiles in the Layers menu — the L.maplibreGL adapter layer. We
   *  keep both in the same ref so the rest of the file can stay
   *  unaware of which renderer is active. */
  const tileLayerRef = useRef<L.Layer | null>(null);
  const trafficFlowLayerRef = useRef<L.TileLayer | null>(null);
  const trafficIncidentLayerRef = useRef<L.TileLayer | null>(null);
  const usingVectorTilesRef = useRef<boolean>(false);
  // Lazy-load the active city's stylized district polygons. `version`
  // bumps once the JSON file lands so the overlay effect below re-runs
  // without a manual reload.
  const { version: districtsVersion } = useCityDistricts();
  const trailLayerRef = useRef<L.LayerGroup | null>(null);
  const districtsLayerRef = useRef<L.LayerGroup | null>(null);
  const parkedPinMarkerRef = useRef<L.Marker | null>(null);
  const selectedHighlightRef = useRef<L.LayerGroup | null>(null);
  /** `flyTo` only on selection change / first coords — not on every incidents poll. */
  const lastFlyToForSelectedIdRef = useRef<string | null>(null);
  /** Avoid map.fitBounds on every live GPS tick when only the origin (A) moves. */
  const previewFitDestRef = useRef<{ lat: number; lng: number } | null>(null);
  const previewFitWaypointsTailRef = useRef<string>("");
  const tripLiveLayersRef = useRef<TripLiveLayers | null>(null);
  const tripCongestionRef = useRef(tripRouteCongestion);
  tripCongestionRef.current = tripRouteCongestion;
  const liveTripDistAlongRef = useRef(0);
  const onTripProgressRef = useRef(onTripProgress);
  onTripProgressRef.current = onTripProgress;

  /** Filled when the map is created (client-only); used by resetView. */
  const cityCenterRef = useRef<[number, number]>([39.9526, -75.1652]);
  const defaultZoomRef = useRef(12);

  // Distinguishes our own panTo()/flyTo()/fitBounds() calls from real
  // user drags & pinches so the follow-me cancel logic only fires on
  // actual gestures.
  const programmaticPanRef = useRef(false);
  const programmaticPanClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markProgrammaticCamera = useCallback((holdMs = 800) => {
    programmaticPanRef.current = true;
    if (programmaticPanClearRef.current) {
      clearTimeout(programmaticPanClearRef.current);
    }
    programmaticPanClearRef.current = setTimeout(() => {
      programmaticPanRef.current = false;
      programmaticPanClearRef.current = null;
    }, holdMs);
  }, []);

  const flyToOffset = useCallback((lat: number, lng: number, zoom = 14) => {
    const map = mapRef.current;
    if (!map) return;
    const targetZoom = zoom;
    const targetPoint = map.project([lat, lng], targetZoom);
    let sidebarPx = 380;
    if (typeof document !== "undefined") {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--pp-map-sidebar-width")
        .trim();
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n)) sidebarPx = n;
    }
    const cardPx = 384;
    const mapW = map.getSize().x;
    const isMobile = mapW < 768;
    const offsetX = isMobile ? 0 : (sidebarPx + cardPx) / 2;
    const offsetY = isMobile ? -100 : 0;
    const shifted = L.point(targetPoint.x - offsetX, targetPoint.y - offsetY);
    const shiftedLatLng = map.unproject(shifted, targetZoom);
    // 900ms covers the 800ms flyTo duration plus slack for zoomend.
    markProgrammaticCamera(900);
    map.flyTo(shiftedLatLng, targetZoom, { duration: 0.8 });
  }, [markProgrammaticCamera]);

  const panelAwareFitOptions = useCallback((maxZoom: number): L.FitBoundsOptions => {
    const map = mapRef.current;
    const size = map?.getSize();
    const mapW = size?.x ?? 0;
    const mapH = size?.y ?? 0;

    if (mapW < 768) {
      let bottomPadding = Math.max(180, Math.round(mapH * 0.42));
      if (typeof document !== "undefined" && map) {
        const sheet = document.querySelector<HTMLElement>('[role="dialog"]');
        const sheetTop = sheet?.getBoundingClientRect().top;
        const mapTop = map.getContainer().getBoundingClientRect().top;
        if (Number.isFinite(sheetTop)) {
          const visibleBottom = Math.max(72, (sheetTop as number) - mapTop - 24);
          bottomPadding = Math.max(180, Math.min(mapH - 72, Math.round(mapH - visibleBottom)));
        }
      }
      return {
        paddingTopLeft: [48, 36],
        paddingBottomRight: [48, bottomPadding],
        maxZoom,
      };
    }

    let sidebarPx = 72;
    if (typeof document !== "undefined") {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--pp-map-sidebar-width")
        .trim();
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n)) sidebarPx = n;
    }

    return {
      paddingTopLeft: [sidebarPx + 96, 96],
      paddingBottomRight: [96, 96],
      maxZoom,
    };
  }, []);

  useImperativeHandle(ref, () => ({
    flyTo: (lat: number, lng: number, zoom = 14) => {
      flyToOffset(lat, lng, zoom);
    },
    resetView: () => {
      markProgrammaticCamera(900);
      mapRef.current?.flyTo(cityCenterRef.current, defaultZoomRef.current, { duration: 0.75 });
    },
    panTo: (lat: number, lng: number) => {
      const map = mapRef.current;
      if (!map) return;
      markProgrammaticCamera(320);
      map.panTo([lat, lng], { animate: true, duration: 0.25 });
    },
    getBounds: () => {
      const map = mapRef.current;
      if (!map) return null;
      const b = map.getBounds();
      return {
        north: b.getNorth(),
        south: b.getSouth(),
        east: b.getEast(),
        west: b.getWest(),
      };
    },
    getCenter: () => {
      const map = mapRef.current;
      if (!map) return null;
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng };
    },
    getContainer: () => {
      const map = mapRef.current;
      if (!map) return null;
      return map.getContainer();
    },
  }));

  const onMapTapRef = useRef(onMapTap);
  onMapTapRef.current = onMapTap;
  const onClusterClickRef = useRef(onClusterClick);
  onClusterClickRef.current = onClusterClick;
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;
  const onMapMoveRef = useRef(onMapMove);
  onMapMoveRef.current = onMapMove;
  const onUserDragRef = useRef(onUserDrag);
  onUserDragRef.current = onUserDrag;

  useEffect(() => {
    if (mapRef.current) return;

    const c = getCurrentCity();
    const center: [number, number] = [
      parseFloat(process.env.NEXT_PUBLIC_MAP_CENTER_LAT || String(c.lat)),
      parseFloat(process.env.NEXT_PUBLIC_MAP_CENTER_LNG || String(c.lng)),
    ];
    const zoom = parseInt(process.env.NEXT_PUBLIC_MAP_ZOOM || "12", 10);
    cityCenterRef.current = center;
    defaultZoomRef.current = zoom;

    // Initial view: prefer the URL hash (`#zoom/lat/lng`, Google-Maps style)
    // so a shared "look at where I'm looking" link works on first paint.
    // Discard hash coordinates more than ~5° (~550 km) from the city center
    // so a stale/corrupted hash doesn't send the map to the middle of the ocean.
    const hashView = parseHashView();
    const hashInRange = hashView &&
      Math.abs(hashView.lat - center[0]) < 5 &&
      Math.abs(hashView.lng - center[1]) < 5;
    const initialCenter: [number, number] = hashInRange
      ? [hashView!.lat, hashView!.lng]
      : center;
    const initialZoom = hashInRange ? hashView!.zoom : zoom;
    const mobileViewport = isMobileViewport();

    const map = L.map("incident-map", {
      zoomControl: false,
      // Slightly more forgiving than Leaflet default (15) for dense
      // marker clusters and gloved / shaky touch on phones. Runtime
      // option; @types/leaflet MapOptions omits it on some versions.
      tapTolerance: 22,
      preferCanvas: mobileViewport,
      zoomAnimation: !mobileViewport,
      fadeAnimation: !mobileViewport,
      // leaflet-rotate options. rotate enables the bearing-aware
      // transform on the map pane; touchRotate enables the
      // two-finger pinch-and-twist gesture (mirrors Google Maps).
      // We deliberately leave rotateControl off — there's no visible
      // compass widget; the user can two-finger-twist to reorient,
      // and the recenter pill resets bearing to 0 on tap.
      rotate: true,
      touchRotate: true,
      bearing: 0,
      rotateControl: false,
      shiftKeyRotate: false,
    } as L.MapOptions).setView(initialCenter, initialZoom);

    L.control.zoom({ position: "topright" }).addTo(map);

    // Initial base layer. The vector-tiles toggle persists in
    // localStorage so we honor it on first paint without waiting for a
    // React render.
    usingVectorTilesRef.current = isVectorTilesEnabled() && !mobileViewport;
    if (usingVectorTilesRef.current) {
      tileLayerRef.current = L.maplibreGL({
        style: vectorBasemapStyleUrl(basemapStyle, isDark),
        attributionControl: false,
      }).addTo(map);
      // The MapLibre layer doesn't surface attribution through Leaflet,
      // so attach the CARTO/OSM credit directly to Leaflet's control.
      map.attributionControl?.addAttribution(basemapAttribution(basemapStyle));
    } else {
      tileLayerRef.current = L.tileLayer(basemapUrl(basemapStyle, isDark), {
        attribution: basemapAttribution(basemapStyle),
        maxZoom: 19,
        updateWhenIdle: true,
        updateWhenZooming: !mobileViewport,
        keepBuffer: mobileViewport ? 2 : 4,
      }).addTo(map);
    }

    markersRef.current = L.markerClusterGroup({
      // Cluster radius drives how aggressively neighboring incident
      // markers collapse into a numbered bubble. Leaflet's default is
      // 80px, which on a 28px marker swallows anything within ~144px
      // of pixel space — far more than visual overlap. We dial it
      // down so a "cluster" only forms when the underlying markers
      // really would draw on top of each other; otherwise the user
      // sees individual pins and can tap straight through to the
      // incident card instead of going through a list panel.
      maxClusterRadius: mobileViewport ? 50 : 40,
      spiderfyOnMaxZoom: false,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: false,
      // Drop clustering entirely once the viewport is at block-level
      // detail (zoom 16+). At that scale there's room for every pin,
      // and a residual cluster bubble feels overzealous. Default
      // would have kept us clustering up to zoom 18.
      disableClusteringAtZoom: 16,
      animate: !mobileViewport,
      chunkedLoading: mobileViewport,
      chunkInterval: mobileViewport ? 120 : 200,
      chunkDelay: mobileViewport ? 60 : 50,
      iconCreateFunction: (cluster: L.MarkerCluster) => {
        const count = cluster.getChildCount();
        let size = 32;
        let cls = "pp-cluster-small";
        if (count >= 50) { size = 44; cls = "pp-cluster-large"; }
        else if (count >= 10) { size = 38; cls = "pp-cluster-medium"; }
        return L.divIcon({
          html: `<div class="pp-cluster ${cls}"><span>${count}</span></div>`,
          className: "pp-cluster-icon",
          iconSize: L.point(size, size),
        });
      },
    }).addTo(map);

    markersRef.current.on("clusterclick", (e: L.LeafletEvent) => {
      const cluster = (e as ClusterClickEvent).layer;
      const bounds = cluster.getBounds();
      const span =
        Math.abs(bounds.getNorth() - bounds.getSouth()) +
        Math.abs(bounds.getEast() - bounds.getWest());
      const currentZoom = map.getZoom();
      // Show the scrollable list panel when:
      // - markers are very close together (< ~110m), OR
      // - we're already zoomed in close (≥16) so further zooming won't help
      if (span < 0.001 || currentZoom >= 16) {
        const childMarkers = cluster.getAllChildMarkers() as L.Marker[];
        const ids: string[] = childMarkers
          .map((m: L.Marker) => (m as IncidentMarker)._ppIncidentId)
          .filter((id: string | undefined): id is string => Boolean(id));
        if (ids.length > 0) onClusterClickRef.current?.(ids);
      } else {
        markProgrammaticCamera(700);
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
      }
    });

    districtsLayerRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    previewLayerRef.current = L.layerGroup().addTo(map);
    trailLayerRef.current = L.layerGroup().addTo(map);
    selectedHighlightRef.current = L.layerGroup().addTo(map);
    safetyPoiLayerRef.current = L.layerGroup().addTo(map);
    nearbyPoiLayerRef.current = L.layerGroup().addTo(map);
    savedPlacesLayerRef.current = L.layerGroup().addTo(map);
    searchedPlaceLayerRef.current = L.layerGroup().addTo(map);
    userAvoidLayerRef.current = L.layerGroup().addTo(map);
    measureLayerRef.current = L.layerGroup().addTo(map);
    perimeterLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    const setZoomCSSVar = (z: number) => {
      const clamped = Math.max(8, Math.min(19, z));
      const scale = Math.max(0.5, Math.min(3.5, Math.pow(2, (clamped - 12) / 2.5)));
      map.getContainer().style.setProperty("--pp-marker-scale", String(scale));
    };
    let zoomRaf = 0;
    const syncIncidentZoom = () => {
      cancelAnimationFrame(zoomRaf);
      zoomRaf = requestAnimationFrame(() => {
        zoomRaf = 0;
        setZoomCSSVar(map.getZoom());
      });
    };
    map.whenReady(() => setZoomCSSVar(map.getZoom()));
    map.on("zoom", syncIncidentZoom);
    map.on("zoomend", syncIncidentZoom);

    // Debounced URL-hash writeback so /, refresh, and "share my view" work.
    let hashWriteTimer: ReturnType<typeof setTimeout> | null = null;
    const writeHash = () => {
      const z = map.getZoom();
      const c = map.getCenter();
      const next = formatHashView(z, c.lat, c.lng);
      if (window.location.hash !== next) {
        window.history.replaceState({}, "", window.location.pathname + window.location.search + next);
      }
    };
    const scheduleHashWrite = () => {
      if (hashWriteTimer) clearTimeout(hashWriteTimer);
      hashWriteTimer = setTimeout(writeHash, 250);
    };
    map.on("moveend", scheduleHashWrite);
    map.on("zoomend", scheduleHashWrite);

    // Debounced viewport updates for the parent (e.g. bbox-driven refetch).
    let movePillTimer: ReturnType<typeof setTimeout> | null = null;
    const dispatchMove = () => {
      if (movePillTimer) clearTimeout(movePillTimer);
      movePillTimer = setTimeout(() => {
        const c = map.getCenter();
        onMapMoveRef.current?.(c.lat, c.lng, map.getZoom());
      }, 250);
    };
    map.on("moveend", dispatchMove);
    map.on("zoomend", dispatchMove);

    // Manual-drag / pinch-zoom detection for follow-me cancellation. We
    // attach to dragstart + zoomstart and ignore programmatic panTo() /
    // flyTo() calls flagged via `programmaticPanRef`. Without the
    // zoomstart hook, pinch-zooming mid-trip wouldn't disengage
    // follow-me and the next GPS tick would re-snap to the user
    // location at the prior zoom.
    const onDragStart = () => {
      mapInteractingRef.current = true;
      if (programmaticPanRef.current) return;
      onUserDragRef.current?.();
    };
    const onInteractionEnd = () => {
      mapInteractingRef.current = false;
      if (!pendingIncidentSyncRef.current) return;
      pendingIncidentSyncRef.current = false;
      queueIncidentSyncRef.current(isMobileViewport() ? 120 : 0);
    };
    map.on("dragstart", onDragStart);
    map.on("dragend", onInteractionEnd);
    const onZoomStart = () => {
      mapInteractingRef.current = true;
      if (programmaticPanRef.current) return;
      onUserDragRef.current?.();
    };
    map.on("zoomstart", onZoomStart);
    map.on("zoomend", onInteractionEnd);

    /**
     * Tap-vs-long-press disambiguation:
     *  - Long-press (>= 500ms with < 8px movement) drops a pin and is consumed.
     *  - A normal click fires the SafetyScoreCard tap callback + Snap pulse.
     *  - Right-click acts as long-press for desktop / trackpad.
     * We attach raw pointer listeners on the Leaflet container so we get
     * pageX/pageY for the screen-space pulse without re-projecting through
     * Leaflet (which would otherwise drift during in-flight zoom).
     */
    const container = map.getContainer();
    const LONG_PRESS_MS = 500;
    const LONG_PRESS_TOLERANCE_PX = 8;
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let pressOrigin: { x: number; y: number; clientX: number; clientY: number } | null = null;
    let longPressFired = false;

    function clearPressTimer() {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    }

    function pointerDown(ev: PointerEvent) {
      if (ev.button !== 0 && ev.pointerType === "mouse") return; // ignore right/middle-click here (handled by contextmenu)
      pressOrigin = { x: ev.clientX, y: ev.clientY, clientX: ev.clientX, clientY: ev.clientY };
      longPressFired = false;
      clearPressTimer();
      pressTimer = setTimeout(() => {
        if (!pressOrigin) return;
        const point = map.mouseEventToLatLng(
          new MouseEvent("click", { clientX: pressOrigin.clientX, clientY: pressOrigin.clientY })
        );
        longPressFired = true;
        if (typeof navigator !== "undefined" && "vibrate" in navigator) {
          try { navigator.vibrate?.(18); } catch { /* ignore */ }
        }
        spawnSnapPulse(container, pressOrigin.clientX, pressOrigin.clientY, {
          color: "rgba(244, 63, 94, 0.85)",
          glow: "rgba(244, 63, 94, 0.45)",
        });
        onLongPressRef.current?.(point.lat, point.lng);
      }, LONG_PRESS_MS);
    }

    function pointerMove(ev: PointerEvent) {
      if (!pressOrigin) return;
      const dx = ev.clientX - pressOrigin.x;
      const dy = ev.clientY - pressOrigin.y;
      if (dx * dx + dy * dy > LONG_PRESS_TOLERANCE_PX * LONG_PRESS_TOLERANCE_PX) {
        clearPressTimer();
        pressOrigin = null;
      }
    }

    function pointerUp() {
      clearPressTimer();
      pressOrigin = null;
    }

    container.addEventListener("pointerdown", pointerDown);
    container.addEventListener("pointermove", pointerMove);
    container.addEventListener("pointerup", pointerUp);
    container.addEventListener("pointercancel", pointerUp);
    container.addEventListener("pointerleave", pointerUp);

    map.on("click", (e: L.LeafletMouseEvent) => {
      if (longPressFired) {
        longPressFired = false;
        return;
      }
      onMapTapRef.current?.(e.latlng.lat, e.latlng.lng);
      const oe = e.originalEvent as MouseEvent | undefined;
      if (oe) {
        spawnSnapPulse(container, oe.clientX, oe.clientY);
      }
    });

    map.on("contextmenu", (e: L.LeafletMouseEvent) => {
      const oe = e.originalEvent as MouseEvent | undefined;
      oe?.preventDefault();
      if (oe) {
        spawnSnapPulse(container, oe.clientX, oe.clientY, {
          color: "rgba(244, 63, 94, 0.85)",
          glow: "rgba(244, 63, 94, 0.45)",
        });
      }
      onLongPressRef.current?.(e.latlng.lat, e.latlng.lng);
    });

    return () => {
      container.removeEventListener("pointerdown", pointerDown);
      container.removeEventListener("pointermove", pointerMove);
      container.removeEventListener("pointerup", pointerUp);
      container.removeEventListener("pointercancel", pointerUp);
      container.removeEventListener("pointerleave", pointerUp);
      clearPressTimer();
      map.off("zoom", syncIncidentZoom);
      map.off("zoomend", syncIncidentZoom);
      map.off("moveend", scheduleHashWrite);
      map.off("zoomend", scheduleHashWrite);
      map.off("moveend", dispatchMove);
      map.off("zoomend", dispatchMove);
      map.off("dragstart", onDragStart);
      map.off("dragend", onInteractionEnd);
      map.off("zoomstart", onZoomStart);
      map.off("zoomend", onInteractionEnd);
      if (hashWriteTimer) clearTimeout(hashWriteTimer);
      if (movePillTimer) clearTimeout(movePillTimer);
      cancelAnimationFrame(zoomRaf);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch tiles when theme, explicit basemap style, or the vector-
  // tiles preference changes. The vector-tiles toggle is handled by
  // tearing down the current layer and recreating one of the right
  // type — `L.tileLayer.setUrl` doesn't apply to the MaplibreGL layer
  // and vice versa.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = (vector: boolean) => {
      const mobileViewport = isMobileViewport();
      const effectiveVector = vector && !mobileViewport;
      const attrControl = map.attributionControl;
      if (tileLayerRef.current) {
        map.removeLayer(tileLayerRef.current);
        tileLayerRef.current = null;
      }
      // Aggressively scrub all known basemap credits before re-adding
      // — Leaflet's attribution control silently dedupes by string, so
      // a stale "OSM Standard" line could otherwise linger after the
      // user picked Voyager.
      if (attrControl) {
        try {
          attrControl.removeAttribution(basemapAttribution("voyager"));
          attrControl.removeAttribution(basemapAttribution("streets"));
        } catch { /* ignore */ }
      }
      if (effectiveVector) {
        tileLayerRef.current = L.maplibreGL({
          style: vectorBasemapStyleUrl(basemapStyle, isDark),
          attributionControl: false,
        }).addTo(map);
        attrControl?.addAttribution(basemapAttribution(basemapStyle));
      } else {
        tileLayerRef.current = L.tileLayer(basemapUrl(basemapStyle, isDark), {
          attribution: basemapAttribution(basemapStyle),
          maxZoom: 19,
          updateWhenIdle: true,
          updateWhenZooming: !mobileViewport,
          keepBuffer: mobileViewport ? 2 : 4,
        }).addTo(map);
      }
      usingVectorTilesRef.current = effectiveVector;
    };

    apply(usingVectorTilesRef.current);
    // React to changes from the Layers menu (or other tabs in the
    // same browser via `storage` events propagated through the lib's
    // pubsub).
    const unsub = subscribeVectorTiles((v) => apply(v));
    return () => { unsub(); };
  }, [isDark, basemapStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const removeTrafficLayers = () => {
      if (trafficFlowLayerRef.current) {
        map.removeLayer(trafficFlowLayerRef.current);
        trafficFlowLayerRef.current = null;
      }
      if (trafficIncidentLayerRef.current) {
        map.removeLayer(trafficIncidentLayerRef.current);
        trafficIncidentLayerRef.current = null;
      }
    };

    if (!trafficLayerEnabled) {
      removeTrafficLayers();
      return;
    }

    trafficFlowLayerRef.current = L.tileLayer("/api/tomtom-traffic/flow/{z}/{x}/{y}", {
      attribution: "Traffic &copy; TomTom",
      maxZoom: 19,
      opacity: 0.62,
      zIndex: 430,
      updateWhenIdle: true,
      keepBuffer: isMobileViewport() ? 1 : 2,
    }).addTo(map);
    trafficIncidentLayerRef.current = L.tileLayer("/api/tomtom-traffic/incidents/{z}/{x}/{y}", {
      attribution: "Traffic incidents &copy; TomTom",
      maxZoom: 19,
      opacity: 0.78,
      zIndex: 440,
      updateWhenIdle: true,
      keepBuffer: isMobileViewport() ? 1 : 2,
    }).addTo(map);

    return removeTrafficLayers;
  }, [trafficLayerEnabled]);

  const stableOnSelect = useCallback(onSelectIncident, [onSelectIncident]);

  // Keep a ref for tripRouteGeometry so we can check it without causing re-renders
  const tripGeomRef = useRef(tripRouteGeometry);
  tripGeomRef.current = tripRouteGeometry;

  // Track the safe route polylines so we can hide/show them without full re-render
  const safePolylinesRef = useRef<L.Polyline[]>([]);

  const runIncidentSync = useCallback(() => {
    if (!layersActive) return;
    if (mapInteractingRef.current) {
      pendingIncidentSyncRef.current = true;
      return;
    }

    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) return;

    if (heatPulseRafRef.current != null) {
      cancelAnimationFrame(heatPulseRafRef.current);
      heatPulseRafRef.current = null;
    }
    if (heatRef.current) {
      map.removeLayer(heatRef.current);
      heatRef.current = null;
    }

    const isTripMode = Boolean(tripRouteGeometry && tripRouteGeometry.length >= 2);

    if (heatmapEnabled) {
      const useDensity = timeFilterHours >= 168;
      const heatData: [number, number, number][] = [];
      const hourDist = (a: number, b: number): number => {
        const d = Math.abs(a - b) % 24;
        return Math.min(d, 24 - d);
      };
      for (const inc of incidents) {
        if (inc.lat == null || inc.lng == null) continue;
        const base = useDensity ? 0.6 : Math.max(inc.w_eff, 0.2);
        let weight = useDensity ? base : heatmapWeight(inc.severity_category, base);
        if (todHourFocus != null) {
          const t = new Date(inc.reported_at);
          const h = t.getHours();
          const d = hourDist(h, todHourFocus);
          const k = d <= 1 ? 1 : d <= 2 ? 0.55 : d <= 3 ? 0.25 : 0.08;
          weight = Math.min(1, weight * k);
        }
        if (isTripMode && tripRouteGeometry) {
          const dist = minDistToRouteKm([inc.lat, inc.lng], tripRouteGeometry);
          const onRoute = dist <= TRIP_PROXIMITY_KM;
          const tripWeight = onRoute
            ? Math.min(1, weight * 1.2)
            : Math.max(0.18, weight * 0.55);
          heatData.push([inc.lat, inc.lng, tripWeight]);
        } else {
          heatData.push([inc.lat, inc.lng, weight]);
        }
      }

      if (heatData.length > 0) {
        const vividGradient = {
          0.0: "rgba(0,0,50,0)",
          0.08: "#0c1a4a",
          0.18: "#1e3a8a",
          0.32: "#2563eb",
          0.48: "#22c55e",
          0.58: "#eab308",
          0.72: "#f97316",
          0.86: "#ef4444",
          1.0: "#dc2626",
        };
        const softRadius = isMobileViewport() ? 56 : 72;
        const softBlur = isMobileViewport() ? 34 : 44;
        const legacyGradient = {
          0.0: "rgba(0,0,40,0)",
          0.1: "#0a0a5c",
          0.2: "#1a1a8f",
          0.35: "#3333cc",
          0.5: "#22b8cf",
          0.6: "#f0e130",
          0.75: "#ff6b1a",
          0.9: "#ef2020",
          1.0: "#ff0040",
        };
        const baseRadius = isTripMode ? (isMobileViewport() ? 48 : 64) : useDensity ? 40 : softRadius;
        const baseBlur = isTripMode ? (isMobileViewport() ? 28 : 38) : useDensity ? 30 : softBlur;
        const heatMax = isTripMode ? 0.9 : useDensity ? 1.0 : 0.85;
        const heatMinOp = isTripMode ? 0.5 : useDensity ? 0.3 : 0.42;
        const gradient = useDensity ? legacyGradient : vividGradient;
        const heat = L.heatLayer(heatData, {
          radius: baseRadius,
          blur: baseBlur,
          maxZoom: 17,
          max: heatMax,
          minOpacity: heatMinOp,
          gradient,
        });
        heat.addTo(map);
        heatRef.current = heat;
      }
    }

    const nextIds = new Set<string>();
    let glyphUid = 0;
    for (const inc of incidents) {
      if (inc.lat == null || inc.lng == null) continue;
      const signature = incidentMarkerSignature(inc, tripRouteGeometry);
      nextIds.add(inc.id);
      const existing = incidentMarkersRef.current.get(inc.id);
      if (existing && existing.signature === signature) continue;

      if (existing) {
        markers.removeLayer(existing.marker);
        incidentMarkersRef.current.delete(inc.id);
      }

      let greyed = false;
      if (isTripMode && tripRouteGeometry) {
        const dist = minDistToRouteKm([inc.lat, inc.lng], tripRouteGeometry);
        greyed = dist > TRIP_PROXIMITY_KM;
      }
      const icon = createIncidentGlyphIcon(
        inc,
        glyphUid++,
        inc.w_eff,
        inc.s_base >= 0.7,
        greyed
      );
      const marker = L.marker([inc.lat, inc.lng], { icon }) as IncidentMarker;
      marker._ppIncidentId = inc.id;
      if (!greyed) marker.on("click", () => stableOnSelect(inc.id));
      markers.addLayer(marker);
      incidentMarkersRef.current.set(inc.id, { marker, signature });
    }

    for (const [id, entry] of incidentMarkersRef.current) {
      if (nextIds.has(id)) continue;
      markers.removeLayer(entry.marker);
      incidentMarkersRef.current.delete(id);
    }
  }, [
    incidents,
    layersActive,
    stableOnSelect,
    tripRouteGeometry,
    heatmapEnabled,
    todHourFocus,
    timeFilterHours,
  ]);

  const queueIncidentSync = useCallback((delay = 0) => {
    if (!layersActive) return;
    if (incidentSyncTimerRef.current) clearTimeout(incidentSyncTimerRef.current);
    incidentSyncTimerRef.current = setTimeout(() => {
      incidentSyncTimerRef.current = null;
      runIncidentSync();
    }, delay);
  }, [layersActive, runIncidentSync]);

  queueIncidentSyncRef.current = queueIncidentSync;

  useEffect(() => {
    if (!layersActive) return;
    queueIncidentSync(isMobileViewport() ? 400 : 120);
    return () => {
      if (incidentSyncTimerRef.current) clearTimeout(incidentSyncTimerRef.current);
    };
  }, [
    incidents,
    tripRouteGeometry,
    heatmapEnabled,
    todHourFocus,
    timeFilterHours,
    heatmapDemoBoost,
    layersActive,
    queueIncidentSync,
  ]);

  useEffect(() => {
    if (!layersActive) return;
    const map = mapRef.current;
    if (!map) return;
    requestAnimationFrame(() => {
      map.invalidateSize();
      queueIncidentSync(0);
    });
  }, [layersActive, queueIncidentSync]);

  // Persistent safety-POI overlay (hospitals/police/fire). Lives in its
  // own layer-group so toggling it doesn't disturb the cluster of
  // incident markers — and so it can be styled with a deliberately
  // different visual language (badge-style, semi-transparent, no click
  // handler beyond a tooltip) since these are reference points, not
  // primary content.
  useEffect(() => {
    const layer = safetyPoiLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!safetyPois || safetyPois.length === 0) return;

    const palette: Record<string, { bg: string; emoji: string; label: string }> = {
      hospital:     { bg: "#22c55e", emoji: "H", label: "Hospital" },
      police:       { bg: "#3b82f6", emoji: "P", label: "Police" },
      fire_station: { bg: "#ef4444", emoji: "F", label: "Fire" },
    };

    for (const poi of safetyPois) {
      const p = palette[poi.category];
      if (!p) continue;
      const icon = L.divIcon({
        className: "pp-safety-poi-marker",
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        html: `<div title="${poi.name.replace(/"/g, "&quot;")}" style="width:20px;height:20px;border-radius:50%;background:${p.bg};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,0.35),0 0 0 2px rgba(255,255,255,0.85);opacity:0.92;font-family:system-ui,-apple-system,sans-serif;letter-spacing:-0.02em;">${p.emoji}</div>`,
      });
      const m = L.marker([poi.lat, poi.lng], {
        icon,
        // Sit underneath incident markers so user-relevant content wins
        // any z-fight when they overlap.
        zIndexOffset: -200,
        keyboard: false,
        interactive: true,
      });
      m.bindTooltip(`${p.label}: ${poi.name}`, {
        direction: "top",
        offset: [0, -12],
        className: "pp-safety-poi-tooltip",
      });
      layer.addLayer(m);
    }
  }, [safetyPois]);

  // Convenience POI overlay (gas, food, EV, ATM, etc). Pill-shaped
  // markers with a colored background and a single-character glyph
  // — visually heavier than safety POIs (which are circles) so a
  // glance can distinguish "where can I get coffee" vs "where's the
  // nearest hospital" without reading labels.
  useEffect(() => {
    const layer = nearbyPoiLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!nearbyPois || nearbyPois.length === 0) return;

    const palette: Record<string, { bg: string; glyph: string; label: string }> = {
      fuel:             { bg: "#f97316", glyph: "G", label: "Gas" },
      charging_station: { bg: "#10b981", glyph: "E", label: "EV" },
      food:             { bg: "#ef4444", glyph: "F", label: "Food" },
      coffee:           { bg: "#a855f7", glyph: "C", label: "Coffee" },
      parking:          { bg: "#3b82f6", glyph: "P", label: "Parking" },
      atm:              { bg: "#0ea5e9", glyph: "$", label: "ATM" },
      toilets:          { bg: "#64748b", glyph: "R", label: "Restroom" },
    };

    for (const poi of nearbyPois) {
      const p = palette[poi.category];
      if (!p) continue;
      const safeName = poi.name.replace(/"/g, "&quot;");
      const icon = L.divIcon({
        className: "pp-nearby-poi-marker",
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        html:
          `<div title="${safeName}" style="width:22px;height:22px;border-radius:6px;background:${p.bg};` +
          `display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:800;` +
          `box-shadow:0 2px 6px rgba(0,0,0,0.35),0 0 0 2px rgba(255,255,255,0.85);` +
          `font-family:system-ui,-apple-system,sans-serif;letter-spacing:-0.02em;opacity:0.94;">${p.glyph}</div>`,
      });
      const m = L.marker([poi.lat, poi.lng], {
        icon,
        // Below incident markers but above safety POIs so they don't
        // hide hospitals/police but do compete a bit with the cluster
        // (where they overlap, the user can still see them).
        zIndexOffset: -100,
        keyboard: false,
        interactive: true,
      });
      m.bindTooltip(`${p.label}: ${poi.name}`, {
        direction: "top",
        offset: [0, -12],
        className: "pp-nearby-poi-tooltip",
      });
      layer.addLayer(m);
    }
  }, [nearbyPois]);

  // Saved-places overlay — Home/Work/Favorite/Custom pins on the map.
  // Sit above incident clusters (so the user can spot their stuff at
  // a glance) but use a deliberately distinct visual language: a teardrop
  // outline with a category glyph inside, so they don't get confused
  // with severity-coloured incident pins.
  useEffect(() => {
    const layer = savedPlacesLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!savedPlaces || savedPlaces.length === 0) return;

    const palette: Record<string, { color: string; glyph: string; label: string }> = {
      home:     { color: "#22c55e", glyph: "&#x1F3E0;", label: "Home" },
      work:     { color: "#3b82f6", glyph: "&#x1F4BC;", label: "Work" },
      favorite: { color: "#f59e0b", glyph: "&#x2605;",  label: "Favorite" },
      custom:   { color: "#94a3b8", glyph: "&#x1F4CD;", label: "Saved" },
    };

    for (const pl of savedPlaces) {
      const p = palette[pl.category];
      if (!p) continue;
      const accent = pl.accentColor ?? p.color;
      const safeName = pl.name.replace(/"/g, "&quot;");
      const icon = L.divIcon({
        className: "pp-saved-place-marker",
        // Teardrop is 24 wide, 32 tall; anchor at the tip (bottom center)
        // so the pin "sticks" to the precise lat/lng instead of floating.
        iconSize: [24, 32],
        iconAnchor: [12, 30],
        popupAnchor: [0, -28],
        html:
          `<div title="${safeName}" style="position:relative;width:24px;height:32px;">` +
          `<div style="position:absolute;top:0;left:0;width:24px;height:24px;border-radius:50% 50% 50% 0;background:${accent};` +
          `transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,0.4),0 0 0 2px rgba(255,255,255,0.85);"></div>` +
          `<div style="position:absolute;top:3px;left:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;` +
          `color:#fff;font-size:11px;font-weight:700;font-family:system-ui,-apple-system,sans-serif;">${p.glyph}</div>` +
          `</div>`,
      });
      const m = L.marker([pl.lat, pl.lng], {
        icon,
        // Sit above incident clusters but below the user dot.
        zIndexOffset: 600,
        keyboard: false,
        interactive: true,
      });
      m.bindTooltip(`${p.label}: ${pl.name}`, {
        direction: "top",
        offset: [0, -28],
        className: "pp-saved-place-tooltip",
      });
      m.on("click", (e) => {
        // Block the underlying map-tap handler (SafetyScoreCard) — the
        // user's intent here is to interact with their saved spot.
        L.DomEvent.stop(e.originalEvent);
        onSavedPlaceClickRef.current?.(pl.id, pl.lat, pl.lng, pl.name);
      });
      layer.addLayer(m);
    }
  }, [savedPlaces]);

  // Personal "Avoid this area" overlay. Always on; subscribes directly
  // to the avoid-areas pubsub so newly-added zones appear immediately.
  // Visual: dashed red ring, slightly less saturated than the
  // route-avoid zones so the user can distinguish "what I told the app
  // to avoid" from "what the app derived from incident clusters".
  useEffect(() => {
    const layer = userAvoidLayerRef.current;
    if (!layer) return;

    const render = () => {
      layer.clearLayers();
      // Lazy import to keep the initial chunk lean — this overlay is
      // only relevant once the user has started using the feature.
      void import("@/lib/avoid-areas").then(({ loadAvoidAreas, USER_DRAWN_AVOID_AREAS_ENABLED }) => {
        if (layer !== userAvoidLayerRef.current) return; // unmounted
        if (!USER_DRAWN_AVOID_AREAS_ENABLED) return;
        for (const a of loadAvoidAreas()) {
          const c = L.circle([a.lat, a.lng], {
            radius: a.radiusM,
            color: "#dc2626",
            fillColor: "#dc2626",
            fillOpacity: 0.08,
            weight: 1.5,
            dashArray: "4 5",
            interactive: true,
          });
          c.bindTooltip(
            a.label
              ? `Avoiding: ${a.label}`
              : `Personal avoid area (${Math.round(a.radiusM)} m)`,
            { direction: "top" }
          );
          layer.addLayer(c);
        }
      });
    };

    render();
    let unsub = () => {};
    void import("@/lib/avoid-areas").then(({ subscribeAvoidAreas }) => {
      unsub = subscribeAvoidAreas(render);
    });
    return () => { unsub(); };
  }, []);

  // Measurement-tool overlay: dashed amber polyline + numbered vertex
  // pins. Cheap to redraw on every change since `measurePoints` is
  // tiny (typically <10 entries) and the layer is opt-in.
  useEffect(() => {
    const layer = measureLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!measurePoints || measurePoints.length === 0) return;

    if (measurePoints.length >= 2) {
      L.polyline(measurePoints, {
        color: "#f59e0b",
        weight: 3,
        opacity: 0.95,
        dashArray: "6 6",
        interactive: false,
      }).addTo(layer);
    }

    measurePoints.forEach(([lat, lng], i) => {
      const num = i + 1;
      const icon = L.divIcon({
        className: "pp-measure-vertex",
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        html:
          `<div style="width:20px;height:20px;border-radius:50%;` +
          `background:#f59e0b;border:2px solid #fff;color:#fff;` +
          `font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;` +
          `box-shadow:0 2px 6px rgba(0,0,0,0.4);font-family:system-ui,-apple-system,sans-serif;">${num}</div>`,
      });
      L.marker([lat, lng], {
        icon,
        keyboard: false,
        interactive: false,
        zIndexOffset: 700,
      }).addTo(layer);
    });
  }, [measurePoints]);

  // Perimeter-tool overlay: forms a filled polygon to visually represent
  // the area being checked for incidents.
  useEffect(() => {
    const layer = perimeterLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!perimeterPoints || perimeterPoints.length === 0) return;

    if (perimeterPoints.length >= 2) {
      // If <3 points, draw a line. If >=3 points, draw a closed polygon.
      if (perimeterPoints.length === 2) {
        L.polyline(perimeterPoints, {
          color: "#a855f7",
          weight: 3,
          opacity: 0.95,
          dashArray: "6 6",
          interactive: false,
        }).addTo(layer);
      } else {
        L.polygon(perimeterPoints, {
          color: "#a855f7",
          weight: 2,
          opacity: 0.8,
          fillColor: "#a855f7",
          fillOpacity: 0.15,
          interactive: false,
        }).addTo(layer);
      }
    }

    perimeterPoints.forEach(([lat, lng]) => {
      const icon = L.divIcon({
        className: "pp-perimeter-vertex",
        iconSize: [12, 12],
        iconAnchor: [6, 6],
        html:
          `<div style="width:12px;height:12px;border-radius:50%;` +
          `background:#a855f7;border:2px solid #fff;` +
          `box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`,
      });
      L.marker([lat, lng], {
        icon,
        keyboard: false,
        interactive: false,
        zIndexOffset: 700,
      }).addTo(layer);
    });
  }, [perimeterPoints]);

  useEffect(() => {
    const highlight = selectedHighlightRef.current;
    if (highlight) highlight.clearLayers();

    if (!selectedId || !mapRef.current) {
      if (!selectedId) lastFlyToForSelectedIdRef.current = null;
      return;
    }
    const map = mapRef.current;
    const inc = incidentsRef.current.find((i) => i.id === selectedId);
    if (inc?.lat == null || inc?.lng == null) return;

    // Center once per selection. The dependency array includes `incidents`
    // so the highlight ring stays in sync, but the feed refetches on a
    // timer — we must not `flyTo` on every refresh or the user cannot
    // pan / zoom away while the detail panel stays open.
    if (lastFlyToForSelectedIdRef.current !== selectedId) {
      lastFlyToForSelectedIdRef.current = selectedId;
      // Preserve the viewer's current zoom when selecting an incident.
      // (But if they're zoomed far out, nudge in enough to make the marker meaningful.)
      flyToOffset(inc.lat, inc.lng, Math.max(map.getZoom(), 15));
    }

    if (highlight) {
      const kind = resolveBlipKind(inc);
      const mc = monoColor(kind);
      const ringSize = 52;
      const half = ringSize / 2;
      const ringIcon = L.divIcon({
        className: "",
        iconSize: [ringSize, ringSize],
        iconAnchor: [half, half],
        html: `<div class="pp-selected-ring" style="
          width:${ringSize}px;height:${ringSize}px;border-radius:50%;
          border:2.5px solid ${mc.fill};
          box-shadow:0 0 12px ${mc.pulse}, 0 0 24px ${mc.pulse};
          pointer-events:none;
        "></div>`,
      });
      L.marker([inc.lat, inc.lng], {
        icon: ringIcon,
        zIndexOffset: 800,
        interactive: false,
      }).addTo(highlight);
    }

    return () => { highlight?.clearLayers(); };
  }, [selectedId, incidents, flyToOffset]);

  // "Parked here" sticky marker — distinct purple car badge so it
  // doesn't get confused with the user's location dot. Passive
  // context; persists across reloads via the parked-pin store.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!parkedPin) {
      if (parkedPinMarkerRef.current) {
        map.removeLayer(parkedPinMarkerRef.current);
        parkedPinMarkerRef.current = null;
      }
      return;
    }

    const icon = L.divIcon({
      className: "",
      iconSize: [38, 48],
      iconAnchor: [19, 46],
      html: `<div class="parked-pin-marker" aria-hidden="true" style="filter:drop-shadow(0 4px 6px rgba(0,0,0,0.4));">
        <svg viewBox="0 0 38 48" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="pp-parked-pin-grad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stop-color="#c084fc"/>
              <stop offset="0.6" stop-color="#a855f7"/>
              <stop offset="1" stop-color="#6b21a8"/>
            </linearGradient>
          </defs>
          <path d="M19 1 C9 1 2 8 2 17 C2 30 19 46 19 46 C19 46 36 30 36 17 C36 8 29 1 19 1 Z"
            fill="url(#pp-parked-pin-grad)" stroke="#4c1d95" stroke-width="1.4"/>
          <circle cx="19" cy="17" r="9" fill="#fff" opacity="0.95"/>
          <text x="19" y="21.5" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="13" font-weight="800" fill="#6b21a8">P</text>
        </svg>
      </div>`,
    });

    if (parkedPinMarkerRef.current) {
      parkedPinMarkerRef.current.setLatLng([parkedPin.lat, parkedPin.lng]);
      parkedPinMarkerRef.current.setIcon(icon);
    } else {
      parkedPinMarkerRef.current = L.marker([parkedPin.lat, parkedPin.lng], {
        icon,
        zIndexOffset: 4500,
        interactive: false,
      }).addTo(map);
      parkedPinMarkerRef.current.bindTooltip("Parked here", {
        direction: "top",
        offset: [0, -42],
      });
    }
  }, [parkedPin]);

  // Kept for back-compat with the old "tap mode" prop; currently a no-op.
  useEffect(() => {
    void mapTapActive;
  }, [mapTapActive]);

  // District overlay ref for click callbacks
  const onDistrictClickRef = useRef(onDistrictClick);
  onDistrictClickRef.current = onDistrictClick;

  // Metro district overlays — game-map style fills with crisp light
  // borders and sparse labels. The geometry comes from
  // `public/districts/*.json` and is intentionally larger + cleaner
  // than the neighborhood registry used elsewhere in the app.
  useEffect(() => {
    const map = mapRef.current;
    const layer = districtsLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!districtsEnabled) return;

    /** Muted fills (game-style); read against dark basemaps. */
    const DISTRICT_FILLS = [
      "#6b9b6e", "#6b93c4", "#c49a5c", "#c47a7a", "#9b7bc4",
      "#c46b9e", "#5ca89a", "#c4885c", "#5c9fc4", "#9bb85c",
      "#b87bc4", "#c49a6e", "#5cb89a", "#8b8fc4", "#c4a85c",
      "#c47a8a", "#4cb0a0", "#a88bc4", "#7bc47a", "#6ba8c4",
    ];
    const BORDER = "rgba(255,255,255,0.46)";
    const BASE_FILL_OPACITY = 0.44;
    const HOVER_FILL_DELTA = 0.1;

    const ringArea = (ring: [number, number][]) => {
      if (ring.length < 3) return 0;
      let a = 0;
      for (let k = 0; k < ring.length - 1; k++) {
        const [lng1, lat1] = ring[k];
        const [lng2, lat2] = ring[k + 1];
        a += lng1 * lat2 - lng2 * lat1;
      }
      return Math.abs(a / 2);
    };

    const approxArea = (n: (typeof DISTRICTS)[0]) => {
      if (n.multiPolygon && n.multiPolygon.length > 0) {
        return n.multiPolygon.reduce(
          (sum, polygon) => sum + ringArea(polygon[0] || []),
          0
        );
      }
      if (n.polygon && n.polygon.length > 0) {
        return n.polygon.reduce((sum, ring) => sum + ringArea(ring), 0);
      }
      const { north, south, east, west } = n.bounds;
      return Math.max(1e-8, (north - south) * (east - west));
    };

    const ordered = DISTRICTS.map((n, idx) => ({ n, idx, area: approxArea(n) })).sort(
      (x, y) => y.area - x.area
    );
    const fillByDistrictIndex = districtFillsGreedy(DISTRICTS, DISTRICT_FILLS);
    const labelCandidates: Array<{
      area: number;
      count: number;
      district: District;
    }> = [];

    for (const { n, idx } of ordered) {
      const fillColor = fillByDistrictIndex[idx];
      const nIncidents = incidentsInDistrict(incidents, n.slug);
      const fillOpacity = BASE_FILL_OPACITY;
      labelCandidates.push({
        area: approxArea(n),
        count: nIncidents.length,
        district: n,
      });

      // Prefer the true GeoJSON polygon when it's been wired in for
      // this neighborhood (lib/neighborhoods.ts); fall back to the
      // axis-aligned rectangle that legacy entries still use. Either
      // way we end up with a Leaflet `Path` we can wire click /
      // hover to identically.
      let shape: L.Path | L.FeatureGroup;
      const polyOptions: L.PolylineOptions = {
        color: BORDER,
        weight: 1.1,
        opacity: 0.84,
        fillColor,
        fillOpacity,
        lineCap: "round",
        lineJoin: "round",
        // smoothFactor: 0 → render exact geo vertices so shared borders
        // between adjacent districts always align perfectly at any zoom.
        smoothFactor: 0,
      };
      if (n.multiPolygon && n.multiPolygon.length > 0) {
        const pieces = n.multiPolygon.map((polygon) =>
          L.polygon(
            polygon.map((ring) =>
              ring.map(([lng, lat]) => [lat, lng] as L.LatLngTuple)
            ),
            { ...polyOptions, fillRule: "evenodd" }
          )
        );
        shape = L.featureGroup(pieces);
      } else if (n.polygon && n.polygon.length > 0) {
        const pieces = n.polygon.map((ring) =>
          L.polygon(
            ring.map(([lng, lat]) => [lat, lng] as L.LatLngTuple),
            polyOptions
          )
        );
        shape = L.featureGroup(pieces);
      } else {
        shape = L.polygon(
          [
            [n.bounds.south, n.bounds.west],
            [n.bounds.south, n.bounds.east],
            [n.bounds.north, n.bounds.east],
            [n.bounds.north, n.bounds.west],
          ],
          polyOptions
        );
      }

      shape.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        onDistrictClickRef.current?.(n, nIncidents);
      });

      shape.on("mouseover", () => {
        shape.setStyle({
          fillOpacity: Math.min(0.78, fillOpacity + HOVER_FILL_DELTA),
          weight: 1.7,
          opacity: 1,
        });
      });
      shape.on("mouseout", () => {
        shape.setStyle({
          fillOpacity,
          weight: 1.1,
          opacity: 0.84,
        });
      });

      shape.addTo(layer);
    }

    const labelBoxes: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    const orderedLabels = [...labelCandidates].sort(
      (a, b) => b.count - a.count || b.area - a.area
    );
    for (const { district } of orderedLabels) {
      const labelPoint = map.latLngToLayerPoint([district.center.lat, district.center.lng]);
      const labelWidth = Math.max(78, Math.min(220, district.name.length * 7.1));
      const labelHeight = 22;
      const box = {
        left: labelPoint.x - labelWidth / 2,
        top: labelPoint.y - labelHeight / 2,
        right: labelPoint.x + labelWidth / 2,
        bottom: labelPoint.y + labelHeight / 2,
      };
      const overlapsExisting = labelBoxes.some((b) =>
        !(box.right < b.left || box.left > b.right || box.bottom < b.top || box.top > b.bottom)
      );
      if (overlapsExisting) continue;
      labelBoxes.push(box);

      const label = L.divIcon({
        className: "",
        html: `<div style="
          white-space: nowrap;
          font-size: 12px;
          font-weight: 800;
          font-family: system-ui, -apple-system, Segoe UI, sans-serif;
          color: #f8fafc;
          letter-spacing: 0.03em;
          text-transform: uppercase;
          pointer-events: none;
          text-align: center;
          text-shadow:
            0 0 10px rgba(0,0,0,0.85),
            0 1px 2px rgba(0,0,0,0.9),
            0 0 1px rgba(0,0,0,1);
        ">
          <span>${district.name}</span>
        </div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      L.marker([district.center.lat, district.center.lng], { icon: label, interactive: false }).addTo(layer);
    }
  }, [districtsEnabled, incidents, districtsVersion]);

  // Routes, avoidance zones, A/B pins — redraw by route signature, not
  // object identity, so route refreshes don't fight mobile pan/zoom.
  useEffect(() => {
    const map = mapRef.current;
    const routeLayer = routeLayerRef.current;
    if (!map || !routeLayer) return;

    const primary = routes?.chosen || routes?.safe || routes?.normal || null;
    const contextSig = routeContextSignature(
      previewOrigin,
      previewDest,
      previewWaypoints,
      primary?.geometry ?? null
    );

    if (!routes) {
      const hasSamePendingRoute =
        contextSig != null && contextSig === lastRouteContextSigRef.current;
      // While the directions panel refreshes/recalculates the same trip,
      // keep the last visible route on the map instead of flashing it off.
      if (hasSamePendingRoute && lastRouteRenderSigRef.current != null) return;

      routeLayer.clearLayers();
      safePolylinesRef.current = [];
      lastRouteRenderSigRef.current = null;
      lastRouteContextSigRef.current = contextSig;
      if (!contextSig) lastRouteFitContextSigRef.current = null;
      return;
    }

    const renderSig = routeLayerSignature(routes, previewWaypoints);
    lastRouteContextSigRef.current = contextSig;
    if (renderSig === lastRouteRenderSigRef.current) return;
    lastRouteRenderSigRef.current = renderSig;

    routeLayer.clearLayers();
    safePolylinesRef.current = [];

    for (const zone of routes.avoidZones) {
      L.circle(zone.center, {
        radius: zone.radiusM,
        color: "#ef444480",
        fillColor: "#ef4444",
        fillOpacity: 0.15,
        weight: 1.5,
        dashArray: "6 4",
      }).addTo(routeLayer);
    }

    const hasSafe = routes.safe?.geometry && routes.safe.geometry.length > 0;
    const hasNormal = routes.normal?.geometry && routes.normal.geometry.length > 0;
    const hasChosen = routes.chosen?.geometry && routes.chosen.geometry.length > 0;

    // Identity check for "this is the highlighted option" — compare by
    // reference first (cheap), fall back to first/last point match for
    // safety. This determines which polyline gets the bold treatment.
    const sameGeom = (
      a: [number, number][] | undefined,
      b: [number, number][] | undefined
    ): boolean => {
      if (!a || !b) return false;
      if (a === b) return true;
      if (a.length !== b.length) return false;
      const f1 = a[0], f2 = b[0];
      const l1 = a[a.length - 1], l2 = b[b.length - 1];
      return f1[0] === f2[0] && f1[1] === f2[1] && l1[0] === l2[0] && l1[1] === l2[1];
    };

    const chosenIsSafe = hasChosen && hasSafe && sameGeom(routes.chosen!.geometry, routes.safe!.geometry);
    const chosenIsNormal = hasChosen && hasNormal && sameGeom(routes.chosen!.geometry, routes.normal!.geometry);

    // Dim background polylines for any non-chosen options that exist.
    // When SAFEST_ROUTE_ONLY_UI is on we never show the grey "fastest"
    // baseline — the geometry still exists on `routes.normal` for devs
    // who flip the flag back.
    if (!SAFEST_ROUTE_ONLY_UI && hasNormal && routes.normal && !chosenIsNormal) {
      L.polyline(routes.normal.geometry, {
        color: "#6b7280",
        weight: 3,
        opacity: 0.3,
        dashArray: "8 8",
      }).addTo(routeLayer);
    }
    if (hasSafe && routes.safe && !chosenIsSafe) {
      const dim = L.polyline(routes.safe.geometry, {
        color: "#22c55e",
        weight: 3,
        opacity: 0.35,
        dashArray: "8 8",
      }).addTo(routeLayer);
      safePolylinesRef.current = [dim];
    }

    // Highlight the chosen route. Color reflects which kind it is.
    if (hasChosen && routes.chosen) {
      const isSaferPick = chosenIsSafe || routes.chosen.isSafe;
      const avoidsFeatures = (routes.chosen.avoidedFeatures?.length ?? 0) > 0;
      const color = isSaferPick ? "#22c55e" : avoidsFeatures ? "#f59e0b" : "#3b82f6";
      const glow = L.polyline(routes.chosen.geometry, {
        color,
        weight: 16,
        opacity: 0.12,
      }).addTo(routeLayer);
      const line = L.polyline(routes.chosen.geometry, {
        color,
        weight: 6,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(routeLayer);
      // Live-traffic congestion overlay (Google-style): paint amber/orange/red
      // over the stretches TomTom flagged as delayed, on top of the base route
      // line. Only present for driving routes resolved via TomTom; absent
      // otherwise, so non-driving / keyless deploys just show the plain line.
      const congestionLines: L.Polyline[] = [];
      const CONGESTION_COLOR: Record<string, string> = {
        moderate: "#f59e0b", // amber
        heavy: "#f97316", // orange
        severe: "#ef4444", // red
      };
      const geom = routes.chosen.geometry;
      for (const span of routes.chosen.congestion ?? []) {
        const from = Math.max(0, Math.min(span.fromIdx, geom.length - 1));
        const to = Math.max(from + 1, Math.min(span.toIdx + 1, geom.length));
        const seg = geom.slice(from, to);
        if (seg.length < 2) continue;
        congestionLines.push(
          L.polyline(seg, {
            color: CONGESTION_COLOR[span.level] ?? "#f59e0b",
            weight: 6,
            opacity: 0.95,
            lineCap: "round",
            lineJoin: "round",
          }).addTo(routeLayer)
        );
      }
      // safePolylinesRef is misnamed historically — it actually holds
      // *the highlighted* polylines so the trip animation can hide them
      // when the live animated route takes over. Always populate it
      // with the chosen pair (+ congestion overlay) regardless of safer-ness.
      safePolylinesRef.current = [glow, line, ...congestionLines];
    } else if (hasNormal && routes.normal && !hasSafe) {
      // No chosen + no safe — fall back to highlighting normal.
      L.polyline(routes.normal.geometry, {
        color: "#3b82f6",
        weight: 14,
        opacity: 0.12,
      }).addTo(routeLayer);
      L.polyline(routes.normal.geometry, {
        color: "#3b82f6",
        weight: 6,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(routeLayer);
    } else if (hasSafe && routes.safe && !hasChosen) {
      const glow = L.polyline(routes.safe.geometry, {
        color: "#22c55e",
        weight: 16,
        opacity: 0.12,
      }).addTo(routeLayer);
      const line = L.polyline(routes.safe.geometry, {
        color: "#22c55e",
        weight: 6,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(routeLayer);
      safePolylinesRef.current = [glow, line];
    }

    if (primary?.geometry && primary.geometry.length >= 2) {
      if (previewWaypoints && previewWaypoints.length > 0) {
        for (const wp of previewWaypoints) {
          L.marker([wp.lat, wp.lng], {
            icon: createEndpointDotIcon(wp.label, wp.color, wp.glowColor),
            zIndexOffset: 2000,
            interactive: false,
          }).addTo(routeLayer);
        }
      } else {
        const startPt = primary.geometry[0];
        const endPt = primary.geometry[primary.geometry.length - 1];
        L.marker(startPt, {
          icon: createEndpointDotIcon("A", "#22c55e", "rgba(34,197,94,0.5)"),
          zIndexOffset: 2000,
          interactive: false,
        }).addTo(routeLayer);
        L.marker(endPt, {
          icon: createEndpointDotIcon("B", "#ef4444", "rgba(239,68,68,0.5)"),
          zIndexOffset: 2000,
          interactive: false,
        }).addTo(routeLayer);
      }

      const allPts = primary.geometry.map((p) => L.latLng(p[0], p[1]));
      const bounds = L.latLngBounds(allPts);
      if (contextSig !== lastRouteFitContextSigRef.current && !mapInteractingRef.current) {
        lastRouteFitContextSigRef.current = contextSig;
        markProgrammaticCamera(900);
        map.fitBounds(bounds, panelAwareFitOptions(15));
      }
    }
  }, [routes, previewOrigin, previewDest, previewWaypoints, markProgrammaticCamera, panelAwareFitOptions]);

  // Shared-trip overlay (recipient view of a "Share ETA" link).
  // Visually distinct from the user's own active trip — dashed cyan stroke
  // so it's obvious this is someone else's route, not navigation guidance.
  const sharedTripLayerRef = useRef<L.LayerGroup | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!sharedTripLayerRef.current) {
      sharedTripLayerRef.current = L.layerGroup().addTo(map);
    }
    const layer = sharedTripLayerRef.current;
    layer.clearLayers();

    if (!sharedTripGeometry || sharedTripGeometry.length < 2) return;

    L.polyline(sharedTripGeometry, {
      color: "#0891b2",
      weight: 12,
      opacity: 0.16,
    }).addTo(layer);
    L.polyline(sharedTripGeometry, {
      color: "#06b6d4",
      weight: 5,
      opacity: 0.95,
      dashArray: "1,10",
      lineCap: "round",
      lineJoin: "round",
    }).addTo(layer);

    if (sharedTripDestination) {
      L.marker(sharedTripDestination, {
        icon: createEndpointDotIcon("✦", "#06b6d4", "rgba(6,182,212,0.5)"),
        zIndexOffset: 2000,
        interactive: false,
      }).addTo(layer);
    }

    const bounds = L.latLngBounds(sharedTripGeometry.map((p) => L.latLng(p[0], p[1])));
    markProgrammaticCamera(900);
    map.fitBounds(bounds, panelAwareFitOptions(15));
  }, [sharedTripGeometry, sharedTripDestination, markProgrammaticCamera, panelAwareFitOptions]);

  // Preview waypoint pins (before GO is pressed)
  useEffect(() => {
    const map = mapRef.current;
    const layer = previewLayerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();

    if (routes) return;

    if (previewWaypoints && previewWaypoints.length > 0) {
      for (const wp of previewWaypoints) {
        L.marker([wp.lat, wp.lng], {
          icon: createEndpointDotIcon(wp.label, wp.color, wp.glowColor),
          zIndexOffset: 1800,
          interactive: false,
        }).addTo(layer);
      }
      if (previewWaypoints.length >= 2) {
        const tailSig = previewWaypoints
          .slice(1)
          .map((w) => `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`)
          .join("|");
        const tailChanged = tailSig !== previewFitWaypointsTailRef.current;
        if (tailChanged) {
          previewFitWaypointsTailRef.current = tailSig;
          const bounds = L.latLngBounds(previewWaypoints.map((wp) => L.latLng(wp.lat, wp.lng)));
          markProgrammaticCamera(900);
          map.fitBounds(bounds, panelAwareFitOptions(14));
        }
      } else {
        previewFitWaypointsTailRef.current = "";
      }
    } else {
      previewFitWaypointsTailRef.current = "";
      if (previewOrigin) {
        L.marker([previewOrigin.lat, previewOrigin.lng], {
          icon: createEndpointDotIcon("A", "#22c55e", "rgba(34,197,94,0.5)"),
          zIndexOffset: 1800,
          interactive: false,
        }).addTo(layer);
      }
      if (previewDest) {
        L.marker([previewDest.lat, previewDest.lng], {
          icon: createEndpointDotIcon("B", "#ef4444", "rgba(239,68,68,0.5)"),
          zIndexOffset: 1800,
          interactive: false,
        }).addTo(layer);
        if (previewOrigin) {
          const destSame =
            previewFitDestRef.current &&
            previewFitDestRef.current.lat === previewDest.lat &&
            previewFitDestRef.current.lng === previewDest.lng;
          if (!destSame) {
            previewFitDestRef.current = {
              lat: previewDest.lat,
              lng: previewDest.lng,
            };
            const bounds = L.latLngBounds([
              L.latLng(previewOrigin.lat, previewOrigin.lng),
              L.latLng(previewDest.lat, previewDest.lng),
            ]);
            markProgrammaticCamera(900);
            map.fitBounds(bounds, panelAwareFitOptions(14));
          }
        }
      } else {
        previewFitDestRef.current = null;
      }
    }
  }, [previewOrigin, previewDest, previewWaypoints, routes, markProgrammaticCamera, panelAwareFitOptions]);

  // Searched-place pin. Drops a Google-Maps-style red lollipop at the
  // place coords and flies the map to it at city-block zoom so the
  // marker is actually visible above the bottom sheet on mobile. We
  // skip the fly-to when the coords haven't changed (the place card's
  // own Overpass/ETA fetches cause parent re-renders that would
  // otherwise re-fly the map mid-look-around).
  useEffect(() => {
    const map = mapRef.current;
    const layer = searchedPlaceLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!searchedPlace) {
      searchedPlaceFlyRef.current = null;
      return;
    }
    L.marker([searchedPlace.lat, searchedPlace.lng], {
      icon: createSearchedPlacePinIcon(),
      // Sit above incident clusters but below the user-location dot
      // so the user can still see "I am here" against the pin.
      zIndexOffset: 2200,
      interactive: false,
      keyboard: false,
    }).addTo(layer);
    const last = searchedPlaceFlyRef.current;
    const same =
      last &&
      Math.abs(last.lat - searchedPlace.lat) < 1e-6 &&
      Math.abs(last.lng - searchedPlace.lng) < 1e-6;
    if (!same) {
      searchedPlaceFlyRef.current = { lat: searchedPlace.lat, lng: searchedPlace.lng };
      // Use the same offset-aware helper as flyTo so the pin lands in
      // the upper, sheet-uncovered half of the viewport on mobile.
      flyToOffset(searchedPlace.lat, searchedPlace.lng, 16);
    }
  }, [searchedPlace, flyToOffset]);

  // User location dot (search view only — directions use preview pin A instead)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!userLocation || routes || previewOrigin) {
      if (userMarkerRef.current) {
        map.removeLayer(userMarkerRef.current);
        userMarkerRef.current = null;
      }
      return;
    }

    const icon = createUserIcon(heatmapDemoBoost, userHeading ?? null);
    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng([userLocation.lat, userLocation.lng]);
      userMarkerRef.current.setIcon(icon);
    } else {
      userMarkerRef.current = L.marker([userLocation.lat, userLocation.lng], {
        icon,
        zIndexOffset: 1500,
        interactive: false,
      }).addTo(map);
    }
    // We only rebuild the full DivIcon when the marker is first added; for
    // subsequent heading updates, we mutate the cone's transform in place to
    // avoid re-rendering the SVG every ~100ms.
  }, [userLocation, routes, previewOrigin, heatmapDemoBoost, userHeading]);

  // Lightweight heading-only update: rotate the existing cone instead of
  // reconstructing the icon. Keeps GPU work to a CSS rotation per ~100ms.
  useEffect(() => {
    const marker = userMarkerRef.current;
    if (!marker || userHeading == null) return;
    const el = marker.getElement();
    if (!el) return;
    const cone = el.querySelector<HTMLElement>(".pp-user-heading-cone");
    if (cone) cone.style.transform = `rotate(${userHeading}deg)`;
  }, [userHeading]);

  // Trip: live GPS only. We deliberately do not animate along the
  // polyline when GPS is unavailable; Start Navigation should never look
  // like real movement unless it is driven by actual location updates.
  //
  // Gate the teardown/rebuild on a geometry-signature change so harmless
  // prop refreshes (a new array reference with identical points, the
  // periodic `routes` settle after a reroute, a GPS-status flip) don't
  // flash the blue line off and reset live progress. When the shape is
  // unchanged, the existing polylines + traveled distance stay put.
  //
  // We intentionally don't use a returned-cleanup pattern here: React
  // would run that cleanup before every re-render of the effect, which
  // — combined with our early-return for unchanged signatures — would
  // tear the polylines down without rebuilding them. Instead we do the
  // teardown inline only when the signature actually changes, and rely
  // on the trailLayer being attached to the map for unmount cleanup.
  const lastTripGeomSigRef = useRef<string | null>(null);
  const lastTripModeSigRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    const trailLayer = trailLayerRef.current;
    if (!map) return;

    const tripActive = Boolean(
      tripMode && tripRouteGeometry && tripRouteGeometry.length >= 2
    );
    const newGeomSig = tripActive ? geometrySignature(tripRouteGeometry) : "none";
    const newModeSig = tripActive ? tripMode || "" : "none";
    if (
      newGeomSig === lastTripGeomSigRef.current &&
      newModeSig === lastTripModeSigRef.current
    ) {
      return;
    }
    lastTripGeomSigRef.current = newGeomSig;
    lastTripModeSigRef.current = newModeSig;

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (transportMarkerRef.current) {
      map.removeLayer(transportMarkerRef.current);
      transportMarkerRef.current = null;
    }
    tripLiveLayersRef.current = null;
    liveTripDistAlongRef.current = 0;
    if (trailLayer) trailLayer.clearLayers();

    if (!tripActive || !tripMode || !tripRouteGeometry || tripRouteGeometry.length < 2) {
      for (const pl of safePolylinesRef.current) {
        (pl as L.Polyline).setStyle({ opacity: pl.options.weight === 16 ? 0.12 : 0.95 });
      }
      return;
    }

    for (const pl of safePolylinesRef.current) {
      (pl as L.Polyline).setStyle({ opacity: 0 });
    }

    const geo = tripRouteGeometry;
    const tripStyle = tripVisualStyle(tripMode);

    const remainingLine = L.polyline(geo, {
      color: tripStyle.remainingColor,
      weight: tripStyle.remainingWeight,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
      dashArray: tripStyle.dashArray,
    }).addTo(trailLayer!);

    const remainingGlow = L.polyline(geo, {
      color: tripStyle.glowColor,
      weight: tripStyle.glowWeight,
      opacity: tripStyle.glowOpacity,
    }).addTo(trailLayer!);

    const guideLine = tripStyle.guideColor
      ? L.polyline(geo, {
          color: tripStyle.guideColor,
          weight: tripStyle.guideWeight ?? 2,
          opacity: 0.9,
          lineCap: "round",
          lineJoin: "round",
          dashArray: tripStyle.guideDashArray,
        }).addTo(trailLayer!)
      : undefined;

    // Live-traffic congestion overlay on the road AHEAD. Painted as static
    // segments now, BELOW the `traveled` line created next — so as you drive,
    // the traveled line covers the congestion you've already passed and only
    // the ahead portion stays colored (Google-style). No per-tick recompute.
    const tripCongestion = tripCongestionRef.current;
    if (tripCongestion && tripCongestion.length > 0) {
      const CONGESTION_COLOR: Record<string, string> = {
        moderate: "#f59e0b", // amber
        heavy: "#f97316", // orange
        severe: "#ef4444", // red
      };
      for (const span of tripCongestion) {
        const from = Math.max(0, Math.min(span.fromIdx, geo.length - 1));
        const to = Math.max(from + 1, Math.min(span.toIdx + 1, geo.length));
        const seg = geo.slice(from, to);
        if (seg.length < 2) continue;
        L.polyline(seg, {
          color: CONGESTION_COLOR[span.level] ?? "#f59e0b",
          weight: tripStyle.remainingWeight,
          opacity: 0.95,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(trailLayer!);
      }
    }

    const traveledLine = L.polyline([], {
      color: tripStyle.traveledColor,
      weight: tripStyle.traveledWeight,
      opacity: 0.9,
      lineCap: "round",
      lineJoin: "round",
      dashArray: tripStyle.dashArray,
    }).addTo(trailLayer!);

    tripLiveLayersRef.current = {
      marker: null,
      traveled: traveledLine,
      remaining: remainingLine,
      remainingGlow,
      guide: guideLine,
    };
    onTripProgressRef.current?.(0);
    // `liveTripGps` and `heatmapDemoBoost` aren't read here — they only
    // matter to the live-tick effect below. Keeping them out of deps
    // avoids rebuilding the polylines (and zeroing live progress) every
    // time GPS status flickers or the heat boost toggles.
  }, [tripMode, tripRouteGeometry]);

  // Stand-alone unmount guard for the trip layer: cancels any pending
  // animation frame and removes the transport marker if the component
  // tears down mid-trip. The polylines themselves live on `trailLayer`,
  // which is removed when the map instance is disposed.
  useEffect(() => {
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      const map = mapRef.current;
      if (map && transportMarkerRef.current) {
        map.removeLayer(transportMarkerRef.current);
        transportMarkerRef.current = null;
      }
    };
  }, []);

  // Live trip: move vehicle and split polylines from real GPS.
  useEffect(() => {
    if (!liveTripGps || !tripMode || !tripRouteGeometry || tripRouteGeometry.length < 2) {
      return;
    }
    if (!userLocation) return;

    const layers = tripLiveLayersRef.current;
    if (!layers) return;

    const geo = tripRouteGeometry;
    const snap = closestDistAlongOnRoute(geo, userLocation.lat, userLocation.lng);
    liveTripDistAlongRef.current = Math.max(liveTripDistAlongRef.current, snap.distAlong);
    const { traveled, remaining, marker } = splitRouteAtDistance(
      geo,
      liveTripDistAlongRef.current
    );

    if (!layers.marker) {
      const map = mapRef.current;
      if (!map) return;
      const liveMarker = L.marker(marker, {
        icon: createTransportIcon(tripMode, heatmapDemoBoost),
        zIndexOffset: 3000,
        interactive: false,
      }).addTo(map);
      layers.marker = liveMarker;
      transportMarkerRef.current = liveMarker;
    }

    layers.marker.setLatLng(marker);
    layers.traveled.setLatLngs(traveled);
    layers.remaining.setLatLngs(remaining);
    layers.remainingGlow.setLatLngs(remaining);
    layers.guide?.setLatLngs(remaining);

    if (tripModeUses3dHeading(tripMode)) {
      let deg = 0;
      if (remaining.length >= 2) {
        deg = bearingDegrees(remaining[0], remaining[1]);
      } else if (traveled.length >= 2) {
        deg = bearingDegrees(traveled[traveled.length - 2], traveled[traveled.length - 1]);
      }
      setTransportMarkerHeading(layers.marker, deg);
    }

    const p =
      snap.totalLen > 0 ? Math.min(1, liveTripDistAlongRef.current / snap.totalLen) : 0;
    onTripProgressRef.current?.(p);
  }, [userLocation, tripMode, tripRouteGeometry, liveTripGps, heatmapDemoBoost]);

  return <div id="incident-map" className="w-full h-full" />;
});

export default IncidentMap;
