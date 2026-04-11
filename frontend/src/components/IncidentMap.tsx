"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";

const PHILLY_CENTER: [number, number] = [39.9526, -75.1652];
const DEFAULT_ZOOM = 12;

interface Props {
  incidents: Incident[];
  selectedId: string | null;
  onSelectIncident: (id: string) => void;
}

function createCircleIcon(color: string, wEff: number): L.DivIcon {
  const size = Math.max(12, Math.min(28, 12 + wEff * 18));
  const opacity = Math.max(0.4, Math.min(1.0, 0.4 + wEff * 0.6));
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="
      width:${size}px;height:${size}px;
      background:${color};
      opacity:${opacity};
      border-radius:50%;
      border:2px solid rgba(255,255,255,0.6);
      box-shadow:0 0 ${size}px ${color}80;
      transition:all 0.3s;
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

  useEffect(() => {
    const markers = markersRef.current;
    if (!markers) return;
    markers.clearLayers();

    for (const inc of incidents) {
      if (inc.lat == null || inc.lng == null) continue;
      const sev = getSeverity(inc.severity_category);
      const icon = createCircleIcon(sev.markerColor, inc.w_eff);
      const marker = L.marker([inc.lat, inc.lng], { icon });
      marker.on("click", () => onSelectIncident(inc.id));
      markers.addLayer(marker);
    }
  }, [incidents, onSelectIncident]);

  useEffect(() => {
    if (!selectedId || !mapRef.current) return;
    const inc = incidents.find((i) => i.id === selectedId);
    if (inc?.lat != null && inc?.lng != null) {
      mapRef.current.flyTo([inc.lat, inc.lng], 15, { duration: 0.8 });
    }
  }, [selectedId, incidents]);

  return <div id="incident-map" className="w-full h-full" />;
}
