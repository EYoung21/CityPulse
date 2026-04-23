"use client";

import { useEffect, useRef, useState } from "react";

interface SpeedSample {
  /** Meters per second. Null until we have ≥2 samples or a hardware reading. */
  mps: number | null;
}

/** Watches `navigator.geolocation` for the duration the hook is `enabled`
 *  and returns the user's instantaneous speed in m/s.
 *
 *  Prefers `coords.speed` (hardware/Doppler-derived) when available;
 *  otherwise computes from successive position deltas with a low-pass
 *  filter to smooth out GPS noise. Returns null until the first usable
 *  reading.
 *
 *  Note: this watches its own GPS subscription rather than piggybacking
 *  on the existing `userLocation` state, so we get sample timestamps
 *  the moment the OS delivers them — which matters for accurate speed
 *  derivation.
 */
export function useGpsSpeed(enabled: boolean): SpeedSample {
  const [mps, setMps] = useState<number | null>(null);
  const lastRef = useRef<{ lat: number; lng: number; t: number } | null>(null);
  const smoothedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !navigator.geolocation) {
      setMps(null);
      lastRef.current = null;
      smoothedRef.current = null;
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        let raw: number | null = null;
        if (typeof pos.coords.speed === "number" && Number.isFinite(pos.coords.speed) && pos.coords.speed >= 0) {
          raw = pos.coords.speed;
        } else if (lastRef.current) {
          const last = lastRef.current;
          const dt = (pos.timestamp - last.t) / 1000;
          if (dt > 0.1 && dt < 30) {
            // Equirectangular: accurate enough for instantaneous m/s at
            // city scale, and avoids dragging in turf for one calc.
            const lat = (last.lat + pos.coords.latitude) * 0.5 * (Math.PI / 180);
            const cosLat = Math.cos(lat);
            const dx = (pos.coords.longitude - last.lng) * cosLat;
            const dy = pos.coords.latitude - last.lat;
            const meters = Math.hypot(dx, dy) * 111320;
            raw = meters / dt;
          }
        }
        lastRef.current = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          t: pos.timestamp,
        };
        if (raw === null) return;
        // Low-pass filter (alpha=0.35) so the readout doesn't jitter on
        // every GPS tick.
        const prev = smoothedRef.current;
        const next = prev === null ? raw : prev * 0.65 + raw * 0.35;
        smoothedRef.current = next;
        // Snap small noise to zero so we don't display "0.4 mph" while
        // standing still.
        setMps(next < 0.6 ? 0 : next);
      },
      () => { /* permission denied or unavailable — silent */ },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [enabled]);

  return { mps };
}

/** User-facing units. Reads from localStorage("pp:units") which is set
 *  elsewhere if the user picks a preference; default = "imperial" in the
 *  US (the only market we ship today). */
export function preferredSpeedUnit(): "mph" | "kmh" {
  if (typeof window === "undefined") return "mph";
  const saved = window.localStorage.getItem("pp:units");
  if (saved === "metric") return "kmh";
  if (saved === "imperial") return "mph";
  return "mph";
}

export function formatSpeed(mps: number | null, unit: "mph" | "kmh" = preferredSpeedUnit()): string {
  if (mps === null) return "-";
  const v = unit === "mph" ? mps * 2.23694 : mps * 3.6;
  return `${Math.round(v)}`;
}
