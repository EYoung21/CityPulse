"use client";

/** A minimal Leaflet map for the live-trip recipient view. We deliberately
 *  don't reuse `IncidentMap` because it pulls in everything we don't need
 *  here (incident layer, voronoi, district overlays, etc.) and the
 *  recipient page should be light enough to load on a flaky LTE connection.
 *
 *  Behavior:
 *    - Auto-fit bounds the first time we get a position+dest pair so the
 *      whole route is visible
 *    - On subsequent ticks, just slide the position marker; never re-zoom
 *      the camera (that would be jarring while watching someone arrive)
 *    - Always uses the dark Carto basemap — recipients are usually
 *      checking on their phone, often outdoors at night ("when will they
 *      get here?"), so dark mode is the right default
 */

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface Props {
  position: { lat: number; lng: number; heading: number | null };
  dest: { lat: number; lng: number; name: string };
}

export default function SimpleLiveMap({ position, dest }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const posMarkerRef = useRef<L.Marker | null>(null);
  const destMarkerRef = useRef<L.Marker | null>(null);
  const fittedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    }).setView([position.lat, position.lng], 14);
    mapRef.current = map;

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      subdomains: "abcd",
    }).addTo(map);

    // Tiny attribution chip in the corner — Carto requires it but the
    // default Leaflet UI is too heavy for a recipient view.
    L.control.attribution({ prefix: false }).addAttribution(
      '© <a href="https://www.openstreetmap.org/copyright">OSM</a> · © <a href="https://carto.com/attributions">CARTO</a>'
    ).addTo(map);

    // Destination marker — checkered flag styling.
    const destIcon = L.divIcon({
      className: "live-dest-icon",
      html: `<div style="width:22px;height:22px;border-radius:50%;background:#22c55e;border:3px solid #0f172a;box-shadow:0 0 0 2px #22c55e;"></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    destMarkerRef.current = L.marker([dest.lat, dest.lng], { icon: destIcon, title: dest.name }).addTo(map);

    // Sender marker — pulsing red dot.
    const senderIcon = L.divIcon({
      className: "live-sender-icon",
      html: `
        <div style="position:relative;width:24px;height:24px;">
          <div style="position:absolute;inset:-12px;border-radius:50%;background:rgba(239,68,68,0.25);animation:live-share-pulse 1.6s ease-in-out infinite;"></div>
          <div style="position:absolute;inset:0;border-radius:50%;background:#ef4444;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>
        </div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    posMarkerRef.current = L.marker([position.lat, position.lng], { icon: senderIcon }).addTo(map);

    return () => {
      map.remove();
      mapRef.current = null;
      posMarkerRef.current = null;
      destMarkerRef.current = null;
    };
    // We intentionally only init once — subsequent prop changes are
    // handled by the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update marker positions / fit bounds.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (posMarkerRef.current) {
      posMarkerRef.current.setLatLng([position.lat, position.lng]);
    }
    if (destMarkerRef.current) {
      destMarkerRef.current.setLatLng([dest.lat, dest.lng]);
    }
    if (!fittedRef.current) {
      const bounds = L.latLngBounds([position.lat, position.lng], [dest.lat, dest.lng]);
      map.fitBounds(bounds, { padding: [80, 80], maxZoom: 16 });
      fittedRef.current = true;
    }
  }, [position.lat, position.lng, dest.lat, dest.lng]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
