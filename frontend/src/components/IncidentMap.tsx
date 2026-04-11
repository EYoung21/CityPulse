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

interface Props {
  incidents: Incident[];
  selectedId: string | null;
  onSelectIncident: (id: string) => void;
  routes?: RouteData | null;
  onMapTap?: (lat: number, lng: number) => void;
}

function createCircleIcon(color: string, wEff: number, isHighSev: boolean): L.DivIcon {
  const size = Math.max(10, Math.min(24, 10 + wEff * 16));
  const opacity = Math.max(0.6, Math.min(1.0, 0.5 + wEff * 0.5));
  const pulseRing = isHighSev
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
        background:${color};
        opacity:${opacity};
        border-radius:50%;
        border:1.5px solid rgba(255,255,255,0.4);
        box-shadow:0 0 ${size}px ${color}50, 0 0 ${size * 2}px ${color}20;
      "></div>
    </div>`,
  });
}

const IncidentMap = forwardRef<MapHandle, Props>(function IncidentMap(
  { incidents, selectedId, onSelectIncident, routes, onMapTap },
  ref
) {
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const heatRef = useRef<L.Layer | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);

  useImperativeHandle(ref, () => ({
    flyTo: (lat: number, lng: number, zoom = 14) => {
      mapRef.current?.flyTo([lat, lng], zoom, { duration: 0.8 });
    },
  }));

  useEffect(() => {
    if (mapRef.current) return;

    const map = L.map("incident-map", {
      zoomControl: false,
    }).setView(PHILLY_CENTER, DEFAULT_ZOOM);

    L.control.zoom({ position: "topright" }).addTo(map);

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19,
      }
    ).addTo(map);

    markersRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    map.on("click", (e: L.LeafletMouseEvent) => {
      if (onMapTap) onMapTap(e.latlng.lat, e.latlng.lng);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [onMapTap]);

  const stableOnSelect = useCallback(onSelectIncident, [onSelectIncident]);

  // Update heatmap + clickable markers when incidents change
  useEffect(() => {
    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) return;

    // Clear previous
    markers.clearLayers();
    if (heatRef.current) {
      map.removeLayer(heatRef.current);
      heatRef.current = null;
    }

    // Build heatmap data: [lat, lng, intensity]
    const heatData: [number, number, number][] = [];
    for (const inc of incidents) {
      if (inc.lat == null || inc.lng == null) continue;
      heatData.push([inc.lat, inc.lng, inc.w_eff]);
    }

    // Add heatmap layer
    if (heatData.length > 0) {
      const heat = L.heatLayer(heatData, {
        radius: 35,
        blur: 25,
        maxZoom: 17,
        max: 1.0,
        minOpacity: 0.3,
        gradient: {
          0.0: "#0d1b2a",
          0.2: "#1b263b",
          0.4: "#e09f3e",
          0.6: "#e76f51",
          0.8: "#e63946",
          1.0: "#ff006e",
        },
      });
      heat.addTo(map);
      heatRef.current = heat;
    }

    // Add small clickable markers on top of heatmap for interaction
    for (const inc of incidents) {
      if (inc.lat == null || inc.lng == null) continue;
      const sev = getSeverity(inc.severity_category);
      const icon = createCircleIcon(sev.markerColor, inc.w_eff, inc.s_base >= 0.7);
      const marker = L.marker([inc.lat, inc.lng], { icon });
      marker.on("click", () => stableOnSelect(inc.id));
      markers.addLayer(marker);
    }
  }, [incidents, stableOnSelect]);

  // Fly to selected incident
  useEffect(() => {
    if (!selectedId || !mapRef.current) return;
    const inc = incidents.find((i) => i.id === selectedId);
    if (inc?.lat != null && inc?.lng != null) {
      mapRef.current.flyTo([inc.lat, inc.lng], 15, { duration: 0.8 });
    }
  }, [selectedId, incidents]);

  // Draw routes and avoidance zones
  useEffect(() => {
    const map = mapRef.current;
    const routeLayer = routeLayerRef.current;
    if (!map || !routeLayer) return;

    routeLayer.clearLayers();

    if (!routes) return;

    // Draw avoidance zones as translucent red circles
    for (const zone of routes.avoidZones) {
      L.circle(zone.center, {
        radius: zone.radiusM,
        color: "#ef444480",
        fillColor: "#ef4444",
        fillOpacity: 0.12,
        weight: 1,
        dashArray: "4 4",
      }).addTo(routeLayer);
    }

    // Normal route (gray dashed)
    if (routes.normal?.geometry && routes.normal.geometry.length > 0) {
      L.polyline(routes.normal.geometry, {
        color: "#6b7280",
        weight: 4,
        opacity: 0.6,
        dashArray: "8 8",
      }).addTo(routeLayer);
    }

    // Safe route (green solid)
    if (routes.safe?.geometry && routes.safe.geometry.length > 0) {
      L.polyline(routes.safe.geometry, {
        color: "#22c55e",
        weight: 5,
        opacity: 0.9,
      }).addTo(routeLayer);

      // Fit map to safe route bounds
      const bounds = L.latLngBounds(
        routes.safe.geometry.map((p) => L.latLng(p[0], p[1]))
      );
      map.fitBounds(bounds, { padding: [60, 60] });
    } else if (routes.normal?.geometry && routes.normal.geometry.length > 0) {
      const bounds = L.latLngBounds(
        routes.normal.geometry.map((p) => L.latLng(p[0], p[1]))
      );
      map.fitBounds(bounds, { padding: [60, 60] });
    }
  }, [routes]);

  return <div id="incident-map" className="w-full h-full" />;
});

export default IncidentMap;
