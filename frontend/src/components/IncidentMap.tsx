"use client";

import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import L from "leaflet";
import "leaflet.heat";
import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";
import type { RouteData } from "@/components/RoutePanel";

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

function createBigPinIcon(
  letter: string,
  bgColor: string,
  glowColor: string
): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [44, 56],
    iconAnchor: [22, 56],
    html: `
      <div style="position:relative;width:44px;height:56px;filter:drop-shadow(0 3px 8px ${glowColor});">
        <svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M22 54C22 54 42 34.5 42 20C42 9.507 33.046 2 22 2C10.954 2 2 9.507 2 20C2 34.5 22 54 22 54Z"
            fill="${bgColor}" stroke="#fff" stroke-width="3"/>
          <circle cx="22" cy="20" r="14" fill="rgba(255,255,255,0.2)"/>
        </svg>
        <div style="
          position:absolute;top:6px;left:0;right:0;
          display:flex;align-items:center;justify-content:center;
          height:28px;
          font-size:17px;font-weight:800;color:#fff;
          text-shadow:0 1px 3px rgba(0,0,0,0.4);
          font-family:ui-monospace,SFMono-Regular,monospace;
        ">${letter}</div>
      </div>
    `,
  });
}

function createUserIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [52, 64],
    iconAnchor: [26, 64],
    html: `
      <div style="position:relative;width:52px;height:64px;filter:drop-shadow(0 4px 12px rgba(34,197,94,0.6));">
        <div style="
          position:absolute;top:0;left:2px;
          width:48px;height:48px;border-radius:50%;
          border:2px solid rgba(34,197,94,0.3);
          animation:pulse-ring 2s cubic-bezier(0.215,0.61,0.355,1) infinite;
        "></div>
        <svg width="52" height="64" viewBox="0 0 52 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M26 62C26 62 48 40 48 24C48 11.85 38.15 2 26 2C13.85 2 4 11.85 4 24C4 40 26 62 26 62Z"
            fill="#22c55e" stroke="#fff" stroke-width="3"/>
          <circle cx="26" cy="23" r="15" fill="rgba(255,255,255,0.2)"/>
        </svg>
        <div style="
          position:absolute;top:8px;left:0;right:0;
          display:flex;align-items:center;justify-content:center;
          height:30px;
          font-size:18px;font-weight:900;color:#fff;
          text-shadow:0 1px 4px rgba(0,0,0,0.4);
          font-family:ui-monospace,SFMono-Regular,monospace;
        ">A</div>
      </div>
    `,
  });
}

function createTransportIcon(mode: string): L.DivIcon {
  const svgs: Record<string, string> = {
    "foot-walking": `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="5" r="2"/><path d="M10 22l3-8 2 2 4-4"/><path d="M10 22l-2-4 2-4 3 2"/></svg>`,
    "cycling-regular": `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h3"/></svg>`,
    "driving-car": `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L18 10l-2.7-3.6A1 1 0 0014.5 6h-5a1 1 0 00-.8.4L6 10l-2.5 1.1C2.7 11.3 2 12.1 2 13v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>`,
  };
  const svg = svgs[mode] || svgs["foot-walking"];
  return L.divIcon({
    className: "",
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    html: `<div style="
      width:40px;height:40px;border-radius:50%;
      background:linear-gradient(135deg,#3b82f6,#6366f1);
      border:3px solid #fff;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 4px 16px rgba(59,130,246,0.6);
      animation:pulse-ring 1.5s ease-in-out infinite;
    ">${svg}</div>`,
  });
}

const TRIP_PROXIMITY_KM = 1.0;

const DARK_TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const LIGHT_TILES = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

const IncidentMap = forwardRef<MapHandle, Props>(function IncidentMap(
  { incidents, selectedId, onSelectIncident, routes, onMapTap, userLocation, tripRouteGeometry, previewOrigin, previewDest, previewWaypoints, tripMode, heatmapEnabled = true, isDark = true, onTripProgress },
  ref
) {
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const heatRef = useRef<L.Layer | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const previewLayerRef = useRef<L.LayerGroup | null>(null);
  const transportMarkerRef = useRef<L.Marker | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const trailLayerRef = useRef<L.LayerGroup | null>(null);

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
    if (heatRef.current) {
      map.removeLayer(heatRef.current);
      heatRef.current = null;
    }

    const isTripMode = tripRouteGeometry && tripRouteGeometry.length >= 2;

    if (heatmapEnabled) {
      const heatData: [number, number, number][] = [];
      for (const inc of incidents) {
        if (inc.lat == null || inc.lng == null) continue;
        const weight = Math.max(inc.w_eff, 0.2);
        if (isTripMode) {
          const dist = minDistToRouteKm([inc.lat, inc.lng], tripRouteGeometry);
          if (dist <= TRIP_PROXIMITY_KM) heatData.push([inc.lat, inc.lng, weight]);
        } else {
          heatData.push([inc.lat, inc.lng, weight]);
        }
      }
      if (heatData.length > 0) {
        const heat = L.heatLayer(heatData, {
          radius: 80,
          blur: 50,
          maxZoom: 17,
          max: 0.8,
          minOpacity: 0.45,
          gradient: {
            0.0:  "rgba(0,0,40,0)",
            0.1:  "#0a0a5c",
            0.2:  "#1a1a8f",
            0.35: "#3333cc",
            0.5:  "#22b8cf",
            0.6:  "#f0e130",
            0.75: "#ff6b1a",
            0.9:  "#ef2020",
            1.0:  "#ff0040",
          },
        });
        heat.addTo(map);
        heatRef.current = heat;
      }
    }

    for (const inc of incidents) {
      if (inc.lat == null || inc.lng == null) continue;
      const sev = getSeverity(inc.severity_category);
      let greyed = false;
      if (isTripMode) {
        const dist = minDistToRouteKm([inc.lat, inc.lng], tripRouteGeometry);
        greyed = dist > TRIP_PROXIMITY_KM;
      }
      const icon = createCircleIcon(sev.markerColor, inc.w_eff, inc.s_base >= 0.7, greyed);
      const marker = L.marker([inc.lat, inc.lng], { icon });
      if (!greyed) marker.on("click", () => stableOnSelect(inc.id));
      markers.addLayer(marker);
    }
  }, [incidents, stableOnSelect, tripRouteGeometry, heatmapEnabled]);

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
        const bounds = L.latLngBounds(previewWaypoints.map(wp => L.latLng(wp.lat, wp.lng)));
        map.fitBounds(bounds, { padding: [100, 100], maxZoom: 14 });
      }
    } else {
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
          const bounds = L.latLngBounds([
            L.latLng(previewOrigin.lat, previewOrigin.lng),
            L.latLng(previewDest.lat, previewDest.lng),
          ]);
          map.fitBounds(bounds, { padding: [100, 100], maxZoom: 14 });
        }
      }
    }
  }, [previewOrigin, previewDest, previewWaypoints, routes]);

  // User location "A" (before any location is selected)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (userMarkerRef.current) {
      map.removeLayer(userMarkerRef.current);
      userMarkerRef.current = null;
    }

    if (!userLocation || routes || previewOrigin) return;

    userMarkerRef.current = L.marker([userLocation.lat, userLocation.lng], {
      icon: createUserIcon(),
      zIndexOffset: 1500,
      interactive: false,
    }).addTo(map);
  }, [userLocation, routes, previewOrigin]);

  // Animated transport icon moving along the route with trail effect
  useEffect(() => {
    const map = mapRef.current;
    const trailLayer = trailLayerRef.current;
    if (!map) return;

    // Clean up previous animation
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (transportMarkerRef.current) {
      map.removeLayer(transportMarkerRef.current);
      transportMarkerRef.current = null;
    }
    if (trailLayer) trailLayer.clearLayers();

    if (!tripMode || !tripRouteGeometry || tripRouteGeometry.length < 2) {
      // Restore safe route polylines when animation stops
      for (const pl of safePolylinesRef.current) {
        (pl as L.Polyline).setStyle({ opacity: pl.options.weight === 16 ? 0.12 : 0.95 });
      }
      return;
    }

    // Hide static safe route polylines — trail layer takes over
    for (const pl of safePolylinesRef.current) {
      (pl as L.Polyline).setStyle({ opacity: 0 });
    }

    const icon = createTransportIcon(tripMode);
    const marker = L.marker(tripRouteGeometry[0], {
      icon,
      zIndexOffset: 3000,
      interactive: false,
    }).addTo(map);
    transportMarkerRef.current = marker;

    // Determine route color based on whether it's a safe route
    const routeColor = "#22c55e"; // green for safe route
    const traveledColor = "#555";
    const traveledOpacity = 0.35;

    // Create the two polyline segments
    // "Remaining" = bright path ahead of the icon
    const remainingLine = L.polyline(tripRouteGeometry, {
      color: routeColor,
      weight: 6,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(trailLayer!);

    // "Remaining" glow
    const remainingGlow = L.polyline(tripRouteGeometry, {
      color: routeColor,
      weight: 16,
      opacity: 0.12,
    }).addTo(trailLayer!);

    // "Traveled" = greyed-out path behind the icon
    const traveledLine = L.polyline([], {
      color: traveledColor,
      weight: 6,
      opacity: traveledOpacity,
      lineCap: "round",
      lineJoin: "round",
      dashArray: "8 6",
    }).addTo(trailLayer!);

    let idx = 0;
    const totalPts = tripRouteGeometry.length;
    const speed = tripMode === "driving-car" ? 3 : tripMode === "cycling-regular" ? 2 : 1;
    const msPerStep = 80 / speed;
    let lastTime = 0;
    let lastTrailUpdate = -1;
    const trailUpdateEvery = 3; // update trail polylines every N steps for performance

    function step(time: number) {
      if (time - lastTime < msPerStep) {
        animFrameRef.current = requestAnimationFrame(step);
        return;
      }
      lastTime = time;
      idx = (idx + 1) % totalPts;
      const pt = tripRouteGeometry![idx];
      marker.setLatLng(pt);

      // Update trail segments periodically
      if (Math.abs(idx - lastTrailUpdate) >= trailUpdateEvery || idx === 0) {
        lastTrailUpdate = idx;

        // Report progress to parent (0 = start, 1 = end)
        const progress = idx / (totalPts - 1);
        onTripProgress?.(progress);

        if (idx === 0) {
          // Reset: full route ahead, nothing traveled
          traveledLine.setLatLngs([]);
          remainingLine.setLatLngs(tripRouteGeometry!);
          remainingGlow.setLatLngs(tripRouteGeometry!);
        } else {
          // Traveled portion (start -> current position) — greyed out
          const traveled = tripRouteGeometry!.slice(0, idx + 1);
          traveledLine.setLatLngs(traveled);

          // Remaining portion (current position -> end) — bright color
          const remaining = tripRouteGeometry!.slice(idx);
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
      if (trailLayer) trailLayer.clearLayers();
      // Restore safe route polylines
      for (const pl of safePolylinesRef.current) {
        (pl as L.Polyline).setStyle({ opacity: pl.options.weight === 16 ? 0.12 : 0.95 });
      }
    };
  }, [tripMode, tripRouteGeometry]);

  return <div id="incident-map" className="w-full h-full" />;
});

export default IncidentMap;
