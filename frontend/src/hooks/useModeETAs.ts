"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/public-api-base";
import type { TransportMode } from "@/lib/routing";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

export type ModeETAStatus = "idle" | "loading" | "ready" | "error";

export interface ModeETA {
  status: ModeETAStatus;
  /** Minutes. May be a stale value while a refresh is loading/erroring. */
  durationMin?: number;
  /** Kilometers. May be a stale value while a refresh is loading/erroring. */
  distanceKm?: number;
}

export function normalizeModeEtaResponse(value: unknown): Pick<ModeETA, "durationMin" | "distanceKm"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.durationMin !== "number" || !Number.isFinite(data.durationMin) ||
    data.durationMin < 0 || data.durationMin > 7 * 24 * 60
  ) {
    return null;
  }
  const distanceKm = typeof data.distanceKm === "number" && Number.isFinite(data.distanceKm) &&
    data.distanceKm >= 0 && data.distanceKm <= 20_000
    ? data.distanceKm
    : undefined;
  return { durationMin: data.durationMin, distanceKm };
}

export function coordKey(point: { lat: number; lng: number } | null): string {
  if (!point) return "";
  // Mobile GPS jitters by a few meters and the live "Your location" origin
  // re-emits ~once a second, which at 4 decimals (~11 m) still crossed grid
  // boundaries often enough to restart every ETA request — making the mode
  // strip visibly blink "…" → "18 min" over and over while standing still
  // (more noticeable now that the Drive ETA does a TomTom round-trip). These
  // are coarse comparison ETAs, so 3 decimals (~110 m) is plenty and keeps
  // the strip stable unless you've actually moved a block.
  return `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
}

function keepPreviousOnError(prev: Record<string, ModeETA>, mode: TransportMode): ModeETA {
  const prior = prev[mode];
  if (typeof prior?.durationMin === "number") {
    return { ...prior, status: "error" };
  }
  return { status: "error" };
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

  const originKey = coordKey(origin);
  const destKey = coordKey(dest);
  // The stops array reference changes every render even when contents
  // are identical, so derive a stable key for the effect dep list.
  const stopsKey = stops.map(coordKey).join("|");
  const inputsRef = useRef({ modes, origin, dest, stops });
  inputsRef.current = { modes, origin, dest, stops };

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    if (!origin || !dest) {
      setEtas({});
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const snapshot = inputsRef.current;
    const timeout = window.setTimeout(() => {
      controller.abort();
      setEtas((prev) => {
        const next = { ...prev };
        for (const mode of snapshot.modes) {
          next[mode] = keepPreviousOnError(prev, mode);
        }
        return next;
      });
    }, 15_000);

    const waypoints: [number, number][] = [
      [snapshot.origin!.lat, snapshot.origin!.lng],
      ...snapshot.stops.map((s) => [s.lat, s.lng] as [number, number]),
      [snapshot.dest!.lat, snapshot.dest!.lng],
    ];

    // Seed all modes as loading up front so the UI immediately shows a
    // spinner under every tab — keeps the row from doing a staggered
    // pop-in as each request lands.
    setEtas((prev) => {
      const next: Record<string, ModeETA> = {};
      for (const m of snapshot.modes) {
        next[m] = typeof prev[m]?.durationMin === "number"
          ? { ...prev[m], status: "loading" }
          : { status: "loading" };
      }
      return next;
    });

    void Promise.all(
      snapshot.modes.map(async (mode) => {
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
            setEtas((prev) => ({ ...prev, [mode]: keepPreviousOnError(prev, mode) }));
            return;
          }
          const data = normalizeModeEtaResponse(await readBoundedJsonResponse(res, 512 * 1024));
          if (controller.signal.aborted) return;
          if (!data) {
            setEtas((prev) => ({ ...prev, [mode]: keepPreviousOnError(prev, mode) }));
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
          setEtas((prev) => ({ ...prev, [mode]: keepPreviousOnError(prev, mode) }));
        }
      })
    ).finally(() => window.clearTimeout(timeout));

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originKey, destKey, stopsKey, modes.join(",")]);

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
