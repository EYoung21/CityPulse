"use client";

import { useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet.heat";
import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";

declare module "leaflet" {
  function heatLayer(
    latlngs: [number, number, number][],
    options?: Record<string, unknown>
  ): L.Layer;
}

const PHILLY_CENTER: [number, number] = [39.9526, -75.1652];
const DEFAULT_ZOOM = 12;

interface Props {
  incidents: Incident[];
  selectedId: string | null;
  onSelectIncident: (id: string) => void;
}

function createCircleIcon(color: string, wEff: number): L.DivIcon {
  const size = Math.max(10, Math.min(22, 10 + wEff * 14));
  const opacity = Math.max(0.5, Math.min(1.0, 0.5 + wEff * 0.5));
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="
      width:${size}px;height:${size}px;
      background:${color};
      opacity:${opacity};
      border-radius:50%;
      border:1.5px solid rgba(255,255,255,0.5);
      box-shadow:0 0 ${size * 0.8}px ${color}60;
    "></div>`,
  });
}

export default function IncidentMap({
  incidents,
  selectedId,
  onSelectIncident,
}: Props) {
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const heatRef = useRef<L.Layer | null>(null);

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
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

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
      const icon = createCircleIcon(sev.markerColor, inc.w_eff);
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

  return <div id="incident-map" className="w-full h-full" />;
}
