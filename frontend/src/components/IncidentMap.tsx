"use client";

import {
  useEffect,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import L from "leaflet";
import "leaflet.heat";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type { Incident } from "@/lib/api";
import { heatmapWeight } from "@/lib/severity";
import type { RouteData } from "@/components/RoutePanel";
import { NEIGHBORHOODS, type Neighborhood, incidentsInNeighborhood } from "@/lib/neighborhoods";
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

/** GTA-style blip “kind” from category + transcript keywords (gun vs knife vs melee). */
function resolveBlipKind(inc: Incident): string {
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

function gid(uid: number, name: string): string {
  return `ppig_${uid}_${name}`;
}

/**
 * Monochrome silhouette per sub-type.  All violence kinds share RED,
 * medical shares BLUE, etc.  Each sub-type has a unique shape.
 */
function monoGlyphSvg(kind: string, uid: number): string {
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
  const mc = monoColor(kind);
  const base = 18;
  const box = 22;
  const half = 11;
  const opacity = greyed ? 0.25 : 0.92;
  const filt = greyed
    ? "filter:grayscale(0.6) saturate(0.3) brightness(0.85);"
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
  previewOrigin?: { lat: number; lng: number } | null;
  previewDest?: { lat: number; lng: number } | null;
  previewWaypoints?: WaypointPin[] | null;
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
  onDistrictClick?: (neighborhood: Neighborhood, incidents: Incident[]) => void;
  onClusterClick?: (incidentIds: string[]) => void;
  /** Long-press / right-click on the map drops a sticky pin. */
  onLongPress?: (lat: number, lng: number) => void;
  /** When set, renders a sticky red dropped-pin marker. Cleared on close. */
  droppedPin?: { lat: number; lng: number } | null;
  /** Sticky purple "Parked here" pin from the parked-pin store. Persists
   *  across reloads (24h TTL) and gets its own visual language to stand
   *  apart from the red exploratory dropped-pin. */
  parkedPin?: { lat: number; lng: number } | null;
  /** Debounced (~250ms) callback fired after pan/zoom with the current map
   *  center + zoom. Used by the "Score this area" pill in `page.tsx`. */
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
function createEndpointDotIcon(label: string, bgColor: string, _glowColor: string): L.DivIcon {
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
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bgColor};border:2px solid rgba(255,255,255,0.95);box-shadow:0 2px 10px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;">${labelHtml}</div>`,
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

/** Small pseudo-3D car (gradients + shadow); no outline icon. Ids are fixed — only one trip marker exists. */
function transportCar3dSvg(): string {
  return `<svg viewBox="0 0 48 48" width="32" height="32" style="display:block" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="pp-car-body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7ee8dc"/>
      <stop offset="0.4" stop-color="#2dd4bf"/>
      <stop offset="1" stop-color="#0f766e"/>
    </linearGradient>
    <linearGradient id="pp-car-roof" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ecfeff"/>
      <stop offset="1" stop-color="#5eead4"/>
    </linearGradient>
    <linearGradient id="pp-car-bumper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#134e4a"/>
      <stop offset="1" stop-color="#042f2e"/>
    </linearGradient>
  </defs>
  <ellipse cx="24" cy="41" rx="17" ry="5" fill="rgba(0,0,0,0.28)"/>
  <g transform="translate(24,22)">
    <path d="M-15 4 L-13 -9 Q-12 -14 -6 -14 L6 -14 Q12 -14 13 -9 L15 4 Q15 9 10 11 L-10 11 Q-15 9 -15 4Z"
      fill="url(#pp-car-body)" stroke="#0f3d3a" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M-9 -12 L-8 -5 L8 -5 L9 -12 Q9 -13 0 -13 Q-9 -13 -9 -12Z"
      fill="url(#pp-car-roof)" stroke="#0d9488" stroke-width="0.9" opacity="0.96"/>
    <path d="M-14 6 L14 6 L13 9 L-13 9 Z" fill="url(#pp-car-bumper)" opacity="0.9"/>
    <ellipse cx="-10" cy="9" rx="4" ry="2.5" fill="#0c4a6e"/>
    <ellipse cx="-10" cy="8.3" rx="1.3" ry="0.85" fill="#94a3b8"/>
    <ellipse cx="10" cy="9" rx="4" ry="2.5" fill="#0c4a6e"/>
    <ellipse cx="10" cy="8.3" rx="1.3" ry="0.85" fill="#94a3b8"/>
    <path d="M-4 -5 L4 -5 L3 -2 L-3 -2 Z" fill="rgba(15,118,110,0.35)"/>
  </g>
</svg>`;
}

/** Pseudo-3D pedestrian: gradients + ground shadow; faces top of viewBox = route forward. */
function transportWalk3dSvg(): string {
  return `<svg viewBox="0 0 48 48" width="32" height="32" style="display:block" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="pp-walk-skin" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fde68a"/>
      <stop offset="1" stop-color="#d97706"/>
    </linearGradient>
    <linearGradient id="pp-walk-shirt" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#93c5fd"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
    <linearGradient id="pp-walk-pants" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#64748b"/>
      <stop offset="1" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <ellipse cx="24" cy="40" rx="14" ry="4" fill="rgba(0,0,0,0.26)"/>
  <g transform="translate(24,21)">
    <circle cx="0" cy="-12" r="5" fill="url(#pp-walk-skin)" stroke="#b45309" stroke-width="0.9"/>
    <path d="M-5 -6 Q-6 2 -4 10 L-2 14 L2 14 L4 10 Q6 2 5 -6 Q0 -8 -5 -6Z" fill="url(#pp-walk-shirt)" stroke="#1d4ed8" stroke-width="0.85"/>
    <path d="M-4 10 L-6 18 L-2 20 L0 14" fill="url(#pp-walk-pants)" stroke="#334155" stroke-width="0.7"/>
    <path d="M4 10 L6 18 L2 20 L0 14" fill="url(#pp-walk-pants)" stroke="#334155" stroke-width="0.7"/>
    <ellipse cx="-8" cy="-2" rx="2.5" ry="2" fill="url(#pp-walk-skin)" opacity="0.9"/>
    <ellipse cx="8" cy="0" rx="2.5" ry="2" fill="url(#pp-walk-skin)" opacity="0.9"/>
  </g>
</svg>`;
}

/** Pseudo-3D cyclist: chunky wheels + frame + rider; forward toward top of viewBox. */
function transportBike3dSvg(): string {
  return `<svg viewBox="0 0 48 48" width="32" height="32" style="display:block" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="pp-bike-tire" cx="35%" cy="35%" r="65%">
      <stop offset="0" stop-color="#475569"/>
      <stop offset="1" stop-color="#0f172a"/>
    </radialGradient>
    <linearGradient id="pp-bike-rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e2e8f0"/>
      <stop offset="1" stop-color="#94a3b8"/>
    </linearGradient>
    <linearGradient id="pp-bike-frame" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fb923c"/>
      <stop offset="1" stop-color="#c2410c"/>
    </linearGradient>
    <linearGradient id="pp-bike-rider" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fdba74"/>
      <stop offset="1" stop-color="#9a3412"/>
    </linearGradient>
  </defs>
  <ellipse cx="24" cy="41" rx="16" ry="4.5" fill="rgba(0,0,0,0.25)"/>
  <g transform="translate(24,22)">
    <circle cx="-10" cy="8" r="7" fill="url(#pp-bike-tire)" stroke="#020617" stroke-width="1"/>
    <circle cx="-10" cy="8" r="3.2" fill="url(#pp-bike-rim)" stroke="#64748b" stroke-width="0.6"/>
    <circle cx="10" cy="8" r="7" fill="url(#pp-bike-tire)" stroke="#020617" stroke-width="1"/>
    <circle cx="10" cy="8" r="3.2" fill="url(#pp-bike-rim)" stroke="#64748b" stroke-width="0.6"/>
    <path d="M-10 8 L-2 -8 L8 -6 L10 8" fill="none" stroke="url(#pp-bike-frame)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M-2 -8 L6 8" fill="none" stroke="url(#pp-bike-frame)" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="-1" cy="-11" r="4" fill="url(#pp-bike-rider)" stroke="#7c2d12" stroke-width="0.8"/>
    <path d="M-3 -7 L-4 2 L-2 6 L2 6 L5 0 L4 -5 L0 -7Z" fill="url(#pp-bike-rider)" stroke="#7c2d12" stroke-width="0.75" opacity="0.95"/>
    <ellipse cx="1" cy="-13" rx="3.5" ry="2.2" fill="#f97316" stroke="#9a3412" stroke-width="0.6"/>
  </g>
</svg>`;
}

const TRIP_MODES_3D: Record<string, string> = {
  "foot-walking": transportWalk3dSvg(),
  "cycling-regular": transportBike3dSvg(),
  "driving-car": transportCar3dSvg(),
};

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

type TripLiveLayers = {
  marker: L.Marker;
  traveled: L.Polyline;
  remaining: L.Polyline;
  remainingGlow: L.Polyline;
};

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
    droppedPin,
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
  },
  ref
) {
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.MarkerClusterGroup | null>(null);
  const heatRef = useRef<L.Layer | null>(null);
  const heatPulseRafRef = useRef<number | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const safetyPoiLayerRef = useRef<L.LayerGroup | null>(null);
  const nearbyPoiLayerRef = useRef<L.LayerGroup | null>(null);
  const savedPlacesLayerRef = useRef<L.LayerGroup | null>(null);
  const userAvoidLayerRef = useRef<L.LayerGroup | null>(null);
  const measureLayerRef = useRef<L.LayerGroup | null>(null);
  // Latest click handler — kept in a ref so the layer effect can stay
  // dependent only on `savedPlaces` and not re-create markers every
  // time the parent rebinds its callback.
  const onSavedPlaceClickRef = useRef(onSavedPlaceClick);
  onSavedPlaceClickRef.current = onSavedPlaceClick;
  const userMarkerRef = useRef<L.Marker | null>(null);
  const previewLayerRef = useRef<L.LayerGroup | null>(null);
  const transportMarkerRef = useRef<L.Marker | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const trailLayerRef = useRef<L.LayerGroup | null>(null);
  const districtsLayerRef = useRef<L.LayerGroup | null>(null);
  const droppedPinMarkerRef = useRef<L.Marker | null>(null);
  const parkedPinMarkerRef = useRef<L.Marker | null>(null);
  const selectedHighlightRef = useRef<L.LayerGroup | null>(null);
  /** Avoid map.fitBounds on every live GPS tick when only the origin (A) moves. */
  const previewFitDestRef = useRef<{ lat: number; lng: number } | null>(null);
  const previewFitWaypointsTailRef = useRef<string>("");
  const tripLiveLayersRef = useRef<TripLiveLayers | null>(null);
  const liveTripDistAlongRef = useRef(0);
  const onTripProgressRef = useRef(onTripProgress);
  onTripProgressRef.current = onTripProgress;

  /** Filled when the map is created (client-only); used by resetView. */
  const cityCenterRef = useRef<[number, number]>([39.9526, -75.1652]);
  const defaultZoomRef = useRef(12);

  const flyToOffset = useCallback((lat: number, lng: number, zoom = 14) => {
    const map = mapRef.current;
    if (!map) return;
    const targetZoom = zoom;
    const targetPoint = map.project([lat, lng], targetZoom);
    const sidebarPx = 380;
    const cardPx = 384;
    const mapW = map.getSize().x;
    const isMobile = mapW < 768;
    const offsetX = isMobile ? 0 : (sidebarPx + cardPx) / 2;
    const offsetY = isMobile ? -100 : 0;
    const shifted = L.point(targetPoint.x - offsetX, targetPoint.y - offsetY);
    const shiftedLatLng = map.unproject(shifted, targetZoom);
    map.flyTo(shiftedLatLng, targetZoom, { duration: 0.8 });
  }, []);

  useImperativeHandle(ref, () => ({
    flyTo: (lat: number, lng: number, zoom = 14) => {
      flyToOffset(lat, lng, zoom);
    },
    resetView: () => {
      mapRef.current?.flyTo(cityCenterRef.current, defaultZoomRef.current, { duration: 0.75 });
    },
    panTo: (lat: number, lng: number) => {
      const map = mapRef.current;
      if (!map) return;
      // 250ms eased pan keeps follow-me smooth without "jumping". The flag
      // tells the dragstart listener to ignore the implicit drag this pan
      // would otherwise look like to Leaflet's internals.
      programmaticPanRef.current = true;
      map.panTo([lat, lng], { animate: true, duration: 0.25 });
      // Clear the flag after the pan settles.
      setTimeout(() => { programmaticPanRef.current = false; }, 320);
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
  }));

  // Distinguishes our own panTo() calls from real user drags so the
  // follow-me cancel logic only fires on actual gestures.
  const programmaticPanRef = useRef(false);

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
    const hashView = parseHashView();
    const initialCenter: [number, number] = hashView
      ? [hashView.lat, hashView.lng]
      : center;
    const initialZoom = hashView ? hashView.zoom : zoom;

    const map = L.map("incident-map", {
      zoomControl: false,
    }).setView(initialCenter, initialZoom);

    L.control.zoom({ position: "topright" }).addTo(map);

    tileLayerRef.current = L.tileLayer(basemapUrl(basemapStyle, isDark), {
      attribution: basemapAttribution(basemapStyle),
      maxZoom: 19,
    }).addTo(map);

    markersRef.current = L.markerClusterGroup({
      maxClusterRadius: 60,
      spiderfyOnMaxZoom: false,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: false,
      disableClusteringAtZoom: 18,
      animate: true,
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
      const cluster = (e as any).layer as L.MarkerCluster;
      const bounds = cluster.getBounds();
      const span =
        Math.abs(bounds.getNorth() - bounds.getSouth()) +
        Math.abs(bounds.getEast() - bounds.getWest());
      const currentZoom = map.getZoom();
      // Show the scrollable list panel when:
      // - markers are very close together (< ~110m), OR
      // - we're already zoomed in close (≥16) so further zooming won't help
      if (span < 0.001 || currentZoom >= 16) {
        const ids: string[] = cluster
          .getAllChildMarkers()
          .map((m: any) => m._ppIncidentId as string)
          .filter(Boolean);
        if (ids.length > 0) onClusterClickRef.current?.(ids);
      } else {
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
    userAvoidLayerRef.current = L.layerGroup().addTo(map);
    measureLayerRef.current = L.layerGroup().addTo(map);
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

    // Same debounce window for the "Score this area" pill in page.tsx — we
    // dispatch the new center so the parent can compare against its anchor.
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

    // Manual-drag detection for follow-me cancellation. We attach to
    // dragstart (real user gesture) and ignore programmatic panTo() calls
    // that we mark via `programmaticPanRef`.
    const onDragStart = () => {
      if (programmaticPanRef.current) return;
      onUserDragRef.current?.();
    };
    map.on("dragstart", onDragStart);

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
      if (hashWriteTimer) clearTimeout(hashWriteTimer);
      if (movePillTimer) clearTimeout(movePillTimer);
      cancelAnimationFrame(zoomRaf);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch tiles when theme or explicit basemap style changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tileLayerRef.current) return;
    tileLayerRef.current.setUrl(basemapUrl(basemapStyle, isDark));
    // Attribution can change too (e.g. CARTO ↔ OSM Standard).
    const attrControl = map.attributionControl;
    if (attrControl) {
      try {
        // Leaflet's attribution control doesn't expose a "replace" API, so we
        // re-add by removing the previous string and inserting the new one.
        attrControl.removeAttribution(basemapAttribution("voyager"));
        attrControl.removeAttribution(basemapAttribution("streets"));
        attrControl.addAttribution(basemapAttribution(basemapStyle));
      } catch {
        /* ignore */
      }
    }
  }, [isDark, basemapStyle]);

  const stableOnSelect = useCallback(onSelectIncident, [onSelectIncident]);

  // Keep a ref for tripRouteGeometry so we can check it without causing re-renders
  const tripGeomRef = useRef(tripRouteGeometry);
  tripGeomRef.current = tripRouteGeometry;

  // Track the safe route polylines so we can hide/show them without full re-render
  const safePolylinesRef = useRef<L.Polyline[]>([]);

  useEffect(() => {
    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) return;

    markers.clearLayers();
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
      // Wrap-around hour distance: e.g. a 23h incident is just 2h away
      // from a 1am focus, not 22h. Used to weight the time-of-day
      // overlay so the hotspots reflect "what happens around this hour"
      // rather than the average over the whole window.
      const hourDist = (a: number, b: number): number => {
        const d = Math.abs(a - b) % 24;
        return Math.min(d, 24 - d);
      };
      for (const inc of incidents) {
        if (inc.lat == null || inc.lng == null) continue;
        // Severity-weighted intensity so the hotspots reflect *what* is
        // happening, not just *that* something is happening. The "density"
        // mode (week+ window) keeps a flatter weight so the map shows raw
        // incident density rather than collapsing toward a few violent
        // pinpoints.
        const base = useDensity ? 0.6 : Math.max(inc.w_eff, 0.2);
        let weight = useDensity ? base : heatmapWeight(inc.severity_category, base);
        if (todHourFocus != null) {
          // Triangular kernel centered on the focus hour: 1.0 at the
          // peak hour, ramping linearly down to a small floor over a
          // ±2h window. Outside that, the incident still contributes a
          // sliver so the overall map context isn't lost — but the
          // peak-hour hotspots clearly dominate.
          const t = new Date(inc.reported_at);
          const h = t.getHours();
          const d = hourDist(h, todHourFocus);
          const k = d <= 1 ? 1 : d <= 2 ? 0.55 : d <= 3 ? 0.25 : 0.08;
          weight = Math.min(1, weight * k);
        }
        if (isTripMode && tripRouteGeometry) {
          const dist = minDistToRouteKm([inc.lat, inc.lng], tripRouteGeometry);
          if (dist <= TRIP_PROXIMITY_KM) heatData.push([inc.lat, inc.lng, weight]);
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
        const softRadius = 72;
        const softBlur = 44;
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
        const baseRadius = useDensity ? 40 : softRadius;
        const baseBlur = useDensity ? 30 : softBlur;
        const heatMax = useDensity ? 1.0 : 0.85;
        const heatMinOp = useDensity ? 0.3 : 0.42;
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

    let glyphUid = 0;
    for (const inc of incidents) {
      if (inc.lat == null || inc.lng == null) continue;
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
      const marker = L.marker([inc.lat, inc.lng], { icon });
      (marker as any)._ppIncidentId = inc.id;
      if (!greyed) marker.on("click", () => stableOnSelect(inc.id));
      markers.addLayer(marker);
    }
  }, [
    incidents,
    stableOnSelect,
    tripRouteGeometry,
    heatmapEnabled,
    todHourFocus,
    timeFilterHours,
    heatmapDemoBoost,
  ]);

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
      void import("@/lib/avoid-areas").then(({ loadAvoidAreas }) => {
        if (layer !== userAvoidLayerRef.current) return; // unmounted
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

  useEffect(() => {
    const highlight = selectedHighlightRef.current;
    if (highlight) highlight.clearLayers();

    if (!selectedId || !mapRef.current) return;
    const inc = incidents.find((i) => i.id === selectedId);
    if (inc?.lat == null || inc?.lng == null) return;

    flyToOffset(inc.lat, inc.lng, 15);

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
        zIndexOffset: 4000,
        interactive: false,
      }).addTo(highlight);
    }

    return () => { highlight?.clearLayers(); };
  }, [selectedId, incidents, flyToOffset]);

  // Sticky dropped-pin marker (long-press / right-click)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!droppedPin) {
      if (droppedPinMarkerRef.current) {
        map.removeLayer(droppedPinMarkerRef.current);
        droppedPinMarkerRef.current = null;
      }
      return;
    }

    const pinIcon = L.divIcon({
      className: "",
      iconSize: [36, 46],
      iconAnchor: [18, 44],
      html: `<div class="dropped-pin-marker" aria-hidden="true">
        <svg viewBox="0 0 36 46" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="pp-drop-pin-grad" cx="50%" cy="35%" r="60%">
              <stop offset="0" stop-color="#fecaca"/>
              <stop offset="0.55" stop-color="#ef4444"/>
              <stop offset="1" stop-color="#7f1d1d"/>
            </radialGradient>
          </defs>
          <path d="M18 1 C8 1 2 8 2 16 C2 28 18 44 18 44 C18 44 34 28 34 16 C34 8 28 1 18 1 Z"
            fill="url(#pp-drop-pin-grad)" stroke="#7f1d1d" stroke-width="1.4"/>
          <circle cx="18" cy="16" r="5.5" fill="#fff" opacity="0.92"/>
          <circle cx="18" cy="16" r="2.5" fill="#7f1d1d"/>
        </svg>
      </div>`,
    });

    if (droppedPinMarkerRef.current) {
      droppedPinMarkerRef.current.setLatLng([droppedPin.lat, droppedPin.lng]);
      droppedPinMarkerRef.current.setIcon(pinIcon);
    } else {
      droppedPinMarkerRef.current = L.marker([droppedPin.lat, droppedPin.lng], {
        icon: pinIcon,
        zIndexOffset: 5000,
        interactive: false,
      }).addTo(map);
    }
  }, [droppedPin]);

  // "Parked here" sticky marker — distinct purple car badge so it
  // doesn't get confused with the red dropped-pin or the user's
  // location dot. Sits at a slightly lower z than the dropped-pin
  // since the latter is the user's *current* exploratory action,
  // while the parked pin is passive context.
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

  // Neighborhood district overlays (Mafia III-style)
  useEffect(() => {
    const map = mapRef.current;
    const layer = districtsLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!districtsEnabled) return;

    const DISTRICT_COLORS = [
      "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
      "#ec4899", "#14b8a6", "#f97316", "#06b6d4", "#a3e635",
      "#e879f9", "#fb923c", "#34d399", "#818cf8", "#fbbf24",
      "#f87171", "#2dd4bf", "#c084fc", "#4ade80", "#38bdf8",
    ];

    for (let i = 0; i < NEIGHBORHOODS.length; i++) {
      const n = NEIGHBORHOODS[i];
      const color = DISTRICT_COLORS[i % DISTRICT_COLORS.length];
      const nIncidents = incidentsInNeighborhood(incidents, n.slug);
      const count = nIncidents.length;

      const severity = count === 0 ? 0 : Math.min(count / 8, 1);
      const fillOpacity = 0.08 + severity * 0.18;

      const rect = L.rectangle(
        [[n.bounds.south, n.bounds.west], [n.bounds.north, n.bounds.east]],
        {
          color,
          weight: 2,
          opacity: 0.6,
          fillColor: color,
          fillOpacity,
          dashArray: "6 3",
        }
      );

      rect.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        onDistrictClickRef.current?.(n, nIncidents);
      });

      rect.on("mouseover", () => {
        rect.setStyle({ fillOpacity: fillOpacity + 0.12, weight: 3, opacity: 0.9 });
      });
      rect.on("mouseout", () => {
        rect.setStyle({ fillOpacity, weight: 2, opacity: 0.6 });
      });

      rect.addTo(layer);

      const label = L.divIcon({
        className: "",
        html: `<div style="
          white-space: nowrap;
          font-size: 11px;
          font-weight: 700;
          color: ${color};
          text-shadow: 0 0 6px rgba(0,0,0,0.9), 0 1px 3px rgba(0,0,0,0.7);
          letter-spacing: 0.5px;
          text-transform: uppercase;
          pointer-events: none;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1px;
        ">
          <span>${n.name}</span>
          ${count > 0 ? `<span style="font-size:9px;opacity:0.8;font-weight:600;">${count} incident${count !== 1 ? "s" : ""}</span>` : ""}
        </div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      L.marker([n.center.lat, n.center.lng], { icon: label, interactive: false }).addTo(layer);
    }
  }, [districtsEnabled, incidents]);

  // Routes, avoidance zones, A/B pins — only re-draws when routes object changes
  useEffect(() => {
    const map = mapRef.current;
    const routeLayer = routeLayerRef.current;
    if (!map || !routeLayer) return;

    routeLayer.clearLayers();
    safePolylinesRef.current = [];
    if (!routes) return;

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
    if (hasNormal && routes.normal && !chosenIsNormal) {
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
      // safePolylinesRef is misnamed historically — it actually holds
      // *the highlighted* polylines so the trip animation can hide them
      // when the live animated route takes over. Always populate it
      // with the chosen pair regardless of safer-ness.
      safePolylinesRef.current = [glow, line];
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

    const primary = routes.chosen || routes.safe || routes.normal;
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
      map.fitBounds(bounds, { padding: [100, 100], maxZoom: 15 });
    }
  }, [routes, previewWaypoints]);

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
    map.fitBounds(bounds, { padding: [100, 100], maxZoom: 15 });
  }, [sharedTripGeometry, sharedTripDestination]);

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
          map.fitBounds(bounds, { padding: [100, 100], maxZoom: 14 });
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
            map.fitBounds(bounds, { padding: [100, 100], maxZoom: 14 });
          }
        }
      } else {
        previewFitDestRef.current = null;
      }
    }
  }, [previewOrigin, previewDest, previewWaypoints, routes]);

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

  // Trip: live GPS (snap to route) or simulated playback
  useEffect(() => {
    const map = mapRef.current;
    const trailLayer = trailLayerRef.current;
    if (!map) return;

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

    if (!tripMode || !tripRouteGeometry || tripRouteGeometry.length < 2) {
      for (const pl of safePolylinesRef.current) {
        (pl as L.Polyline).setStyle({ opacity: pl.options.weight === 16 ? 0.12 : 0.95 });
      }
      return;
    }

    for (const pl of safePolylinesRef.current) {
      (pl as L.Polyline).setStyle({ opacity: 0 });
    }

    const geo = tripRouteGeometry;
    const icon = createTransportIcon(tripMode, heatmapDemoBoost);
    const routeColor = "#22c55e";
    const traveledColor = "#3b82f6";

    // —— Live GPS trip: layers updated in a separate effect on userLocation ——
    if (liveTripGps) {
      const marker = L.marker(geo[0], {
        icon,
        zIndexOffset: 3000,
        interactive: false,
      }).addTo(map);
      transportMarkerRef.current = marker;
      if (tripModeUses3dHeading(tripMode) && geo.length >= 2) {
        setTransportMarkerHeading(marker, bearingDegrees(geo[0], geo[1]));
      }

      const remainingLine = L.polyline(geo, {
        color: routeColor,
        weight: 6,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(trailLayer!);

      const remainingGlow = L.polyline(geo, {
        color: routeColor,
        weight: 16,
        opacity: 0.12,
      }).addTo(trailLayer!);

      const traveledLine = L.polyline([], {
        color: traveledColor,
        weight: 6,
        opacity: 0.9,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(trailLayer!);

      tripLiveLayersRef.current = {
        marker,
        traveled: traveledLine,
        remaining: remainingLine,
        remainingGlow,
      };

      return () => {
        tripLiveLayersRef.current = null;
        liveTripDistAlongRef.current = 0;
        if (transportMarkerRef.current) {
          map.removeLayer(transportMarkerRef.current);
          transportMarkerRef.current = null;
        }
        trailLayer?.clearLayers();
        for (const pl of safePolylinesRef.current) {
          (pl as L.Polyline).setStyle({ opacity: pl.options.weight === 16 ? 0.12 : 0.95 });
        }
      };
    }

    // —— Demo: play along polyline when GPS unavailable ——
    const marker = L.marker(geo[0], {
      icon,
      zIndexOffset: 3000,
      interactive: false,
    }).addTo(map);
    transportMarkerRef.current = marker;
    if (tripModeUses3dHeading(tripMode) && geo.length >= 2) {
      setTransportMarkerHeading(marker, bearingDegrees(geo[0], geo[1]));
    }

    const remainingLine = L.polyline(geo, {
      color: routeColor,
      weight: 6,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(trailLayer!);

    const remainingGlow = L.polyline(geo, {
      color: routeColor,
      weight: 16,
      opacity: 0.12,
    }).addTo(trailLayer!);

    const traveledLine = L.polyline([], {
      color: "#555",
      weight: 6,
      opacity: 0.35,
      lineCap: "round",
      lineJoin: "round",
      dashArray: "8 6",
    }).addTo(trailLayer!);

    let idx = 0;
    const totalPts = geo.length;
    const speed = tripMode === "driving-car" ? 3 : tripMode === "cycling-regular" ? 2 : 1;
    const msPerStep = 80 / speed;
    let lastTime = 0;
    let lastTrailUpdate = -1;
    const trailUpdateEvery = 3;

    function step(time: number) {
      if (time - lastTime < msPerStep) {
        animFrameRef.current = requestAnimationFrame(step);
        return;
      }
      lastTime = time;
      idx = (idx + 1) % totalPts;
      const pt = geo[idx];
      marker.setLatLng(pt);
      if (tripModeUses3dHeading(tripMode)) {
        const next = geo[(idx + 1) % totalPts];
        setTransportMarkerHeading(marker, bearingDegrees(pt, next));
      }

      if (Math.abs(idx - lastTrailUpdate) >= trailUpdateEvery || idx === 0) {
        lastTrailUpdate = idx;
        const progress = idx / (totalPts - 1);
        onTripProgressRef.current?.(progress);

        if (idx === 0) {
          traveledLine.setLatLngs([]);
          remainingLine.setLatLngs(geo);
          remainingGlow.setLatLngs(geo);
        } else {
          const traveled = geo.slice(0, idx + 1);
          traveledLine.setLatLngs(traveled);
          const remaining = geo.slice(idx);
          remainingLine.setLatLngs(remaining);
          remainingGlow.setLatLngs(remaining);
        }
      }

      animFrameRef.current = requestAnimationFrame(step);
    }
    animFrameRef.current = requestAnimationFrame(step);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (transportMarkerRef.current) {
        map.removeLayer(transportMarkerRef.current);
        transportMarkerRef.current = null;
      }
      trailLayer?.clearLayers();
      for (const pl of safePolylinesRef.current) {
        (pl as L.Polyline).setStyle({ opacity: pl.options.weight === 16 ? 0.12 : 0.95 });
      }
    };
  }, [tripMode, tripRouteGeometry, liveTripGps, heatmapDemoBoost]);

  // Live trip: move vehicle and split polylines from GPS (SearchBar watchPosition)
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

    layers.marker.setLatLng(marker);
    layers.traveled.setLatLngs(traveled);
    layers.remaining.setLatLngs(remaining);
    layers.remainingGlow.setLatLngs(remaining);

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
  }, [userLocation, tripMode, tripRouteGeometry, liveTripGps]);

  return <div id="incident-map" className="w-full h-full" />;
});

export default IncidentMap;
