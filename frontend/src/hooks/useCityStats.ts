"use client";

/**
 * useCityStats
 *
 * Fetches live landing-page stats for a city from the backend
 * `/api/city-stats/:slug` endpoint. Polls on a cadence so the stat
 * strip ticks up while a visitor sits on the page.
 *
 * - Initial fetch on mount
 * - Refetch every `refreshMs` (default 30s) while the tab is visible
 * - Pauses while the tab is hidden (no wasted bandwidth/queries)
 * - Falls back to `null` on error; callers use their static defaults
 */

import { useEffect, useRef, useState } from "react";

export interface CityStats {
  slug: string;
  cityName: string;
  /** Number of scanner feeds we listen to for this city. */
  scannerFeeds: number;
  /** Incidents in the last 24h (-1 if unavailable, e.g. SQLite dev). */
  incidents24h: number;
  /** All-time incidents for this city (-1 if unavailable). */
  incidentsTotal: number;
  generatedAt: string;
}

interface ApiPayload {
  slug: string;
  city_name: string;
  scanner_feeds: number;
  incidents_24h: number;
  incidents_total: number;
  generated_at: string;
}

function mapPayload(p: ApiPayload): CityStats {
  return {
    slug: p.slug,
    cityName: p.city_name,
    scannerFeeds: p.scanner_feeds,
    incidents24h: p.incidents_24h,
    incidentsTotal: p.incidents_total,
    generatedAt: p.generated_at,
  };
}

export interface UseCityStatsOptions {
  /** Poll cadence in ms. Default 30_000 (30s). Set to 0 to disable polling. */
  refreshMs?: number;
}

export function useCityStats(
  slug: string | undefined,
  opts: UseCityStatsOptions = {},
): {
  stats: CityStats | null;
  loading: boolean;
  error: string | null;
} {
  const { refreshMs = 30_000 } = opts;
  const [stats, setStats] = useState<CityStats | null>(null);
  const [loading, setLoading] = useState(!!slug);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!slug) {
      setStats(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchOnce() {
      // Abort any in-flight request (visibility change can stack them).
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const r = await fetch(
          `/api/city-stats/${encodeURIComponent(slug!)}`,
          { headers: { Accept: "application/json" }, signal: ctrl.signal },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const payload = (await r.json()) as ApiPayload;
        if (cancelled) return;
        setStats(mapPayload(payload));
        setError(null);
      } catch (e: unknown) {
        if (cancelled) return;
        // AbortError from visibility/unmount is expected; don't surface it.
        const name = (e as { name?: string } | null)?.name;
        if (name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    fetchOnce();

    if (refreshMs <= 0) {
      return () => {
        cancelled = true;
        abortRef.current?.abort();
      };
    }

    let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
      // Skip polling while the tab is hidden — resume on visibilitychange.
      if (document.visibilityState === "visible") fetchOnce();
    }, refreshMs);

    function onVisibility() {
      if (document.visibilityState === "visible") {
        // Catch up immediately when the tab comes back.
        fetchOnce();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [slug, refreshMs]);

  return { stats, loading, error };
}
