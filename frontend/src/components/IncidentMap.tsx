"use client";

import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import L from "leaflet";
import "leaflet.heat";
import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";
import type { RouteData } from "@/components/RoutePanel";
import { phillyDemoHeatPoints } from "@/lib/demo-heat";

declare module "leaflet" {
  function heatLayer(
    latlngs: [number, number, number][],
    options?: Record<string, unknown>
  ): L.Layer;
}

const PHILLY_CENTER: [number, number] = [39.9526, -75.1652];
const DEFAULT_ZOOM = 12;

export interface MapHandle {
  flyTo: (lat: number, lng: number, zoom?: number) => void;
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
  userLocation?: { lat: number; lng: number } | null;
  tripRouteGeometry?: [number, number][] | null;
  previewOrigin?: { lat: number; lng: number } | null;
  previewDest?: { lat: number; lng: number } | null;
  previewWaypoints?: WaypointPin[] | null;
  tripMode?: string | null;
  heatmapEnabled?: boolean;
  isDark?: boolean;
  onTripProgress?: (progress: number) => void;
  liveTripGps?: boolean;
  timeFilterHours?: number;
  /** Demo: vivid heat + pulse + radiating vehicle / user marker (e.g. route sim checkbox). */
  heatmapDemoBoost?: boolean;
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

function createCircleIcon(color: string, wEff: number, isHighSev: boolean, greyed: boolean): L.DivIcon {
  const size = Math.max(10, Math.min(24, 10 + wEff * 16));
  const opacity = greyed ? 0.15 : Math.max(0.6, Math.min(1.0, 0.5 + wEff * 0.5));
  const displayColor = greyed ? "#555" : color;
  const pulseRing = isHighSev && !greyed
    ? `<div style="
        position:absolute;top:50%;left:50%;
        width:${size * 2.5}px;height:${size * 2.5}px;
        margin-left:-${size * 1.25}px;margin-top:-${size * 1.25}px;
        border-radius:50%;border:1.5px solid ${color}40;
        animation:pulse-ring 2s cubic-bezier(0.215,0.61,0.355,1) infinite;
      "></div>`
    : "";
  return L.divIcon({
    className: "",
    iconSize: [size * 3, size * 3],
    iconAnchor: [size * 1.5, size * 1.5],
    html: `<div style="position:relative;width:${size * 3}px;height:${size * 3}px;">
      ${pulseRing}
      <div style="
        position:absolute;top:50%;left:50%;
        width:${size}px;height:${size}px;
        margin-left:-${size / 2}px;margin-top:-${size / 2}px;
        background:${displayColor};
        opacity:${opacity};
        border-radius:50%;
        border:1.5px solid ${greyed ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.4)"};
        box-shadow:${greyed ? "none" : `0 0 ${size}px ${color}50, 0 0 ${size * 2}px ${color}20`};
      "></div>
    </div>`,
  });
}

function createDistrictIcon(color: string): L.DivIcon {
  const size = 40;
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="position:relative;width:${size}px;height:${size}px;">
      <div style="
        position:absolute;top:0;left:0;
        width:${size}px;height:${size}px;
        background:${color};
        opacity:0.18;
        border-radius:50%;
        border:2px dashed ${color}80;
      "></div>
      <div style="
        position:absolute;top:50%;left:50%;
        width:6px;height:6px;
        margin-left:-3px;margin-top:-3px;
        background:${color};
        opacity:0.5;
        border-radius:50%;
      "></div>
    </div>`,
  });
}

function createBigPinIcon(
  letter: string,
  bgColor: string,
  _glowColor: string
): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [32, 46],
    iconAnchor: [16, 46],
    html: `
      <div style="position:relative;width:32px;height:46px;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.35));">
        <svg width="32" height="46" viewBox="0 0 32 46" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="14" r="13" fill="${bgColor}" stroke="#fff" stroke-width="2"/>
          <polygon points="10,25 16,45 22,25" fill="${bgColor}"/>
          <line x1="16" y1="27" x2="16" y2="45" stroke="#fff" stroke-width="0" />
        </svg>
        <div style="
          position:absolute;top:2px;left:0;right:0;
          display:flex;align-items:center;justify-content:center;
          height:24px;
          font-size:13px;font-weight:800;color:#fff;
          font-family:ui-monospace,SFMono-Regular,monospace;
        ">${letter}</div>
      </div>
    `,
  });
}

function createUserIcon(radiate = false): L.DivIcon {
  const pin = `
      <div style="position:relative;width:32px;height:46px;filter:drop-shadow(0 2px 6px rgba(34,197,94,0.4));">
        <svg width="32" height="46" viewBox="0 0 32 46" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="14" r="13" fill="#22c55e" stroke="#fff" stroke-width="2"/>
          <polygon points="10,25 16,45 22,25" fill="#22c55e"/>
        </svg>
        <div style="
          position:absolute;top:2px;left:0;right:0;
          display:flex;align-items:center;justify-content:center;
          height:24px;
          font-size:13px;font-weight:800;color:#fff;
          font-family:ui-monospace,SFMono-Regular,monospace;
        ">A</div>
      </div>`;
  if (!radiate) {
    return L.divIcon({
      className: "",
      iconSize: [32, 46],
      iconAnchor: [16, 46],
      html: pin,
    });
  }
  return L.divIcon({
    className: "",
    iconSize: [32, 46],
    iconAnchor: [16, 46],
    html: `
      <div style="position:relative;width:32px;height:46px;">
        <div class="demo-live-glow-ring demo-live-glow-ring--green" style="position:absolute;left:16px;top:14px;width:30px;height:30px;margin:-15px 0 0 -15px;"></div>
        <div class="demo-live-glow-ring demo-live-glow-ring--green" style="animation-delay:0.65s;position:absolute;left:16px;top:14px;width:30px;height:30px;margin:-15px 0 0 -15px;"></div>
        <div class="demo-live-glow-ring demo-live-glow-ring--green" style="animation-delay:1.3s;position:absolute;left:16px;top:14px;width:30px;height:30px;margin:-15px 0 0 -15px;"></div>
        <div style="position:relative;z-index:2;">${pin}</div>
      </div>`,
  });
}

function createTransportIcon(mode: string, radiate = false): L.DivIcon {
  const svgs: Record<string, string> = {
    "foot-walking": `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="5" r="2"/><path d="M10 22l3-8 2 2 4-4"/><path d="M10 22l-2-4 2-4 3 2"/></svg>`,
    "cycling-regular": `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h3"/></svg>`,
    "driving-car": `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L18 10l-2.7-3.6A1 1 0 0014.5 6h-5a1 1 0 00-.8.4L6 10l-2.5 1.1C2.7 11.3 2 12.1 2 13v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>`,
  };
  const svg = svgs[mode] || svgs["foot-walking"];
  const coreAnim = radiate ? "" : "animation:pulse-ring 1.5s ease-in-out infinite;";
  const core = `<div style="
      position:relative;z-index:2;
      width:40px;height:40px;border-radius:50%;
      background:linear-gradient(135deg,#3b82f6,#6366f1);
      border:3px solid #fff;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 4px 20px rgba(59,130,246,0.75),0 0 24px rgba(96,165,250,0.45);
      ${coreAnim}
    ">${svg}</div>`;
  if (!radiate) {
    return L.divIcon({
      className: "",
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      html: core,
    });
  }
  return L.divIcon({
    className: "",
    iconSize: [56, 56],
    iconAnchor: [28, 28],
    html: `
      <div style="position:relative;width:56px;height:56px;display:flex;align-items:center;justify-content:center;">
        <div class="demo-live-glow-ring demo-live-glow-ring--blue" style="position:absolute;left:50%;top:50%;width:42px;height:42px;margin:-21px 0 0 -21px;"></div>
        <div class="demo-live-glow-ring demo-live-glow-ring--blue" style="animation-delay:0.65s;position:absolute;left:50%;top:50%;width:42px;height:42px;margin:-21px 0 0 -21px;"></div>
        <div class="demo-live-glow-ring demo-live-glow-ring--blue" style="animation-delay:1.3s;position:absolute;left:50%;top:50%;width:42px;height:42px;margin:-21px 0 0 -21px;"></div>
        ${core}
      </div>`,
  });
}

const TRIP_PROXIMITY_KM = 1.0;

const DARK_TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const LIGHT_TILES = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

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
    userLocation,
    tripRouteGeometry,
    previewOrigin,
    previewDest,
    previewWaypoints,
    tripMode,
    heatmapEnabled = true,
    isDark = true,
    onTripProgress,
    liveTripGps = false,
    timeFilterHours = 0,
    heatmapDemoBoost = false,
  },
  ref
) {
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const heatRef = useRef<L.Layer | null>(null);
  const heatPulseRafRef = useRef<number | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const previewLayerRef = useRef<L.LayerGroup | null>(null);
  const transportMarkerRef = useRef<L.Marker | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const trailLayerRef = useRef<L.LayerGroup | null>(null);
  /** Avoid map.fitBounds on every live GPS tick when only the origin (A) moves. */
  const previewFitDestRef = useRef<{ lat: number; lng: number } | null>(null);
  const previewFitWaypointsTailRef = useRef<string>("");
  const tripLiveLayersRef = useRef<TripLiveLayers | null>(null);
  const liveTripDistAlongRef = useRef(0);
  const onTripProgressRef = useRef(onTripProgress);
  onTripProgressRef.current = onTripProgress;

  useImperativeHandle(ref, () => ({
    flyTo: (lat: number, lng: number, zoom = 14) => {
      mapRef.current?.flyTo([lat, lng], zoom, { duration: 0.8 });
    },
  }));

  const onMapTapRef = useRef(onMapTap);
  onMapTapRef.current = onMapTap;

  useEffect(() => {
    if (mapRef.current) return;

    const map = L.map("incident-map", {
      zoomControl: false,
    }).setView(PHILLY_CENTER, DEFAULT_ZOOM);

    L.control.zoom({ position: "topright" }).addTo(map);

    tileLayerRef.current = L.tileLayer(isDark ? DARK_TILES : LIGHT_TILES, {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19,
    }).addTo(map);

    markersRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    previewLayerRef.current = L.layerGroup().addTo(map);
    trailLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    map.on("click", (e: L.LeafletMouseEvent) => {
      onMapTapRef.current?.(e.latlng.lat, e.latlng.lng);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch tiles when theme changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tileLayerRef.current) return;
    tileLayerRef.current.setUrl(isDark ? DARK_TILES : LIGHT_TILES);
  }, [isDark]);

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
    const countWithLat = incidents.filter((i) => i.lat != null && i.lng != null).length;
    const useDemoFill = heatmapDemoBoost || countWithLat < 12;

    if (heatmapEnabled) {
      const useDensity = timeFilterHours >= 168;
      const heatData: [number, number, number][] = [];
      for (const inc of incidents) {
        if (inc.lat == null || inc.lng == null) continue;
        const weight = useDensity ? 0.6 : Math.max(inc.w_eff, 0.2);
        if (isTripMode && tripRouteGeometry) {
          const dist = minDistToRouteKm([inc.lat, inc.lng], tripRouteGeometry);
          if (dist <= TRIP_PROXIMITY_KM) heatData.push([inc.lat, inc.lng, weight]);
        } else {
          heatData.push([inc.lat, inc.lng, weight]);
        }
      }

      if (useDemoFill) {
        const demoPts = phillyDemoHeatPoints();
        if (isTripMode && tripRouteGeometry) {
          for (const [lat, lng, w] of demoPts) {
            const dist = minDistToRouteKm([lat, lng], tripRouteGeometry);
            if (dist <= TRIP_PROXIMITY_KM) heatData.push([lat, lng, w * (heatmapDemoBoost ? 1 : 0.75)]);
          }
        } else {
          for (const p of demoPts) heatData.push(p);
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
        const softRadius = heatmapDemoBoost ? 86 : useDemoFill ? 82 : 72;
        const softBlur = heatmapDemoBoost ? 52 : useDemoFill ? 48 : 44;
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
        const heatMinOp = useDensity ? 0.3 : heatmapDemoBoost ? 0.48 : 0.42;
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

        if (heatmapDemoBoost) {
          type HeatLayerPulse = L.Layer & {
            setOptions: (o: Record<string, unknown>) => HeatLayerPulse;
          };
          const h = heat as HeatLayerPulse;
          const tick = () => {
            const t = Date.now() / 900;
            const pulse = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(t));
            const blurPulse = 0.92 + 0.14 * (0.5 + 0.5 * Math.cos(t * 1.12));
            h.setOptions({
              radius: Math.round(baseRadius * pulse),
              blur: Math.round(baseBlur * blurPulse),
              minOpacity: 0.36 + 0.16 * (0.5 + 0.5 * Math.sin(t * 0.85)),
            });
            heatPulseRafRef.current = requestAnimationFrame(tick);
          };
          heatPulseRafRef.current = requestAnimationFrame(tick);
        }
      }
    }

    for (const inc of incidents) {
      if (inc.lat == null || inc.lng == null) continue;
      const sev = getSeverity(inc.severity_category);
      let greyed = false;
      if (isTripMode && tripRouteGeometry) {
        const dist = minDistToRouteKm([inc.lat, inc.lng], tripRouteGeometry);
        greyed = dist > TRIP_PROXIMITY_KM;
      }
      const isDistrict = inc.location_confidence === "district";
      const icon = isDistrict
        ? createDistrictIcon(greyed ? "#555" : sev.markerColor)
        : createCircleIcon(sev.markerColor, inc.w_eff, inc.s_base >= 0.7, greyed);
      const marker = L.marker([inc.lat, inc.lng], { icon });
      if (!greyed) marker.on("click", () => stableOnSelect(inc.id));
      markers.addLayer(marker);
    }
  }, [
    incidents,
    stableOnSelect,
    tripRouteGeometry,
    heatmapEnabled,
    timeFilterHours,
    heatmapDemoBoost,
  ]);

  useEffect(() => {
    if (!selectedId || !mapRef.current) return;
    const inc = incidents.find((i) => i.id === selectedId);
    if (inc?.lat != null && inc?.lng != null) {
      mapRef.current.flyTo([inc.lat, inc.lng], 15, { duration: 0.8 });
    }
  }, [selectedId, incidents]);

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

    if (hasNormal && routes.normal) {
      if (hasSafe) {
        L.polyline(routes.normal.geometry, {
          color: "#6b7280",
          weight: 3,
          opacity: 0.3,
          dashArray: "8 8",
        }).addTo(routeLayer);
      } else {
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
      }
    }

    // Draw safe route polylines (will be hidden when trip animation starts)
    if (hasSafe && routes.safe) {
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

    const primary = routes.safe || routes.normal;
    if (primary?.geometry && primary.geometry.length >= 2) {
      if (previewWaypoints && previewWaypoints.length > 0) {
        for (const wp of previewWaypoints) {
          L.marker([wp.lat, wp.lng], {
            icon: createBigPinIcon(wp.label, wp.color, wp.glowColor),
            zIndexOffset: 2000,
            interactive: false,
          }).addTo(routeLayer);
        }
      } else {
        const startPt = primary.geometry[0];
        const endPt = primary.geometry[primary.geometry.length - 1];
        L.marker(startPt, {
          icon: createBigPinIcon("A", "#22c55e", "rgba(34,197,94,0.5)"),
          zIndexOffset: 2000,
          interactive: false,
        }).addTo(routeLayer);
        L.marker(endPt, {
          icon: createBigPinIcon("B", "#ef4444", "rgba(239,68,68,0.5)"),
          zIndexOffset: 2000,
          interactive: false,
        }).addTo(routeLayer);
      }

      const allPts = primary.geometry.map((p) => L.latLng(p[0], p[1]));
      const bounds = L.latLngBounds(allPts);
      map.fitBounds(bounds, { padding: [100, 100], maxZoom: 15 });
    }
  }, [routes, previewWaypoints]);

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
          icon: createBigPinIcon(wp.label, wp.color, wp.glowColor),
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
          icon: createBigPinIcon("A", "#22c55e", "rgba(34,197,94,0.5)"),
          zIndexOffset: 1800,
          interactive: false,
        }).addTo(layer);
      }
      if (previewDest) {
        L.marker([previewDest.lat, previewDest.lng], {
          icon: createBigPinIcon("B", "#ef4444", "rgba(239,68,68,0.5)"),
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

    const icon = createUserIcon(heatmapDemoBoost);
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
  }, [userLocation, routes, previewOrigin, heatmapDemoBoost]);

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

    const p =
      snap.totalLen > 0 ? Math.min(1, liveTripDistAlongRef.current / snap.totalLen) : 0;
    onTripProgressRef.current?.(p);
  }, [userLocation, tripMode, tripRouteGeometry, liveTripGps]);

  return <div id="incident-map" className="w-full h-full" />;
});

export default IncidentMap;
