"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/public-api-base";
import type { TransportMode } from "@/lib/routing";

export type ModeETAStatus = "idle" | "loading" | "ready" | "error";

export interface ModeETA {
  status: ModeETAStatus;
  /** Minutes. Only meaningful when status === "ready". */
  durationMin?: number;
  /** Kilometers. Only meaningful when status === "ready". */
  distanceKm?: number;
}

/**
 * Fetches a quick ETA for every transport mode in parallel so the
 * directions panel can render Google-Maps-style "🚗 42 min · 🚴 1h 11 ·
 * 🚶 4h 5" labels under each mode tab. Each call is a vanilla
 * `/api/route-directions` POST — no incident avoidance, no alternatives
 * — so it stays cheap even when the user is just hovering between modes.
 *
 * Re-runs when origin or destination changes. Stops on unmount via an
 * AbortController so we don't drop stale ETAs onto a later origin.
 */
export function useModeETAs(
  modes: TransportMode[],
  origin: { lat: number; lng: number } | null,
  dest: { lat: number; lng: number } | null,
  stops: { lat: number; lng: number }[] = []
): Record<string, ModeETA> {
  const [etas, setEtas] = useState<Record<string, ModeETA>>({});
  const abortRef = useRef<AbortController | null>(null);

  // The stops array reference changes every render even when contents
  // are identical, so derive a stable key for the effect dep list.
  const stopsKey = stops.map((s) => `${s.lat},${s.lng}`).join("|");

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    if (!origin || !dest) {
      setEtas({});
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;

    const waypoints: [number, number][] = [
      [origin.lat, origin.lng],
      ...stops.map((s) => [s.lat, s.lng] as [number, number]),
      [dest.lat, dest.lng],
    ];

    // Seed all modes as loading up front so the UI immediately shows a
    // spinner under every tab — keeps the row from doing a staggered
    // pop-in as each request lands.
    setEtas((prev) => {
      const next: Record<string, ModeETA> = {};
      for (const m of modes) {
        next[m] = prev[m]?.status === "ready"
          ? { ...prev[m], status: "loading" }
          : { status: "loading" };
      }
      return next;
    });

    void Promise.all(
      modes.map(async (mode) => {
        try {
          const res = await fetch(apiUrl("/api/route-directions"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ waypoints, mode }),
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          if (!res.ok) {
            setEtas((prev) => ({ ...prev, [mode]: { status: "error" } }));
            return;
          }
          const data = (await res.json()) as {
            durationMin?: number;
            distanceKm?: number;
          };
          if (controller.signal.aborted) return;
          if (typeof data.durationMin !== "number") {
            setEtas((prev) => ({ ...prev, [mode]: { status: "error" } }));
            return;
          }
          setEtas((prev) => ({
            ...prev,
            [mode]: {
              status: "ready",
              durationMin: data.durationMin,
              distanceKm: data.distanceKm,
            },
          }));
        } catch (err) {
          if ((err as { name?: string })?.name === "AbortError") return;
          setEtas((prev) => ({ ...prev, [mode]: { status: "error" } }));
        }
      })
    );

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin?.lat, origin?.lng, dest?.lat, dest?.lng, stopsKey, modes.join(",")]);

  return etas;
}

/** Compact "42 min" / "1 h 10" / "<1 min" label used by the mode strip. */
export function formatEtaShort(durationMin: number): string {
  if (!Number.isFinite(durationMin) || durationMin <= 0) return "<1 min";
  if (durationMin < 1) return "<1 min";
  if (durationMin < 60) return `${Math.round(durationMin)} min`;
  const h = Math.floor(durationMin / 60);
  const m = Math.round(durationMin - h * 60);
  if (m === 0) return `${h} h`;
  return `${h} h ${m}`;
}
