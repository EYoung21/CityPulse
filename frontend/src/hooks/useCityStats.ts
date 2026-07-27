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
import { apiUrl } from "@/lib/public-api-base";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

export interface CityStats {
  slug: string;
  cityName: string;
  /** Number of active structured public-data sources for this city. */
  publicSources: number;
  /** Incidents in the last 24h (-1 if unavailable, e.g. SQLite dev). */
  incidents24h: number;
  /** All-time incidents for this city (-1 if unavailable). */
  incidentsTotal: number;
  generatedAt: string;
}

interface ApiPayload {
  slug: string;
  city_name: string;
  public_sources: number;
  incidents_24h: number;
  incidents_total: number;
  generated_at: string;
}

function mapPayload(p: ApiPayload): CityStats {
  return {
    slug: p.slug,
    cityName: p.city_name,
    publicSources: p.public_sources,
    incidents24h: p.incidents_24h,
    incidentsTotal: p.incidents_total,
    generatedAt: p.generated_at,
  };
}

export function normalizeCityStatsPayload(value: unknown): ApiPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const clean = (field: unknown, max: number) =>
    typeof field === "string" && field.trim() ? field.trim().slice(0, max) : null;
  const slug = clean(row.slug, 100);
  const cityName = clean(row.city_name, 200);
  const generatedAt = clean(row.generated_at, 100);
  const count = (field: unknown, min: number) =>
    typeof field === "number" && Number.isSafeInteger(field) && field >= min ? field : null;
  const publicSources = count(row.public_sources ?? row.scanner_feeds, 0);
  const incidents24h = count(row.incidents_24h, -1);
  const incidentsTotal = count(row.incidents_total, -1);
  if (
    !slug || !cityName || !generatedAt || !Number.isFinite(Date.parse(generatedAt)) ||
    publicSources === null || incidents24h === null || incidentsTotal === null
  ) {
    return null;
  }
  return {
    slug,
    city_name: cityName,
    public_sources: publicSources,
    incidents_24h: incidents24h,
    incidents_total: incidentsTotal,
    generated_at: generatedAt,
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
  const requestedRefreshMs = opts.refreshMs ?? 30_000;
  const refreshMs = Number.isFinite(requestedRefreshMs) && requestedRefreshMs > 0
    ? Math.max(1_000, Math.min(24 * 60 * 60_000, requestedRefreshMs))
    : 0;
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
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, 10_000);
      try {
        const r = await fetch(
          apiUrl(`/api/city-stats/${encodeURIComponent(slug!)}`),
          { headers: { Accept: "application/json" }, signal: ctrl.signal },
        );
        if (!r.ok) {
          // 404 just means the deploy doesn't expose this endpoint yet
          // (e.g. backend not wired up on this domain). Fall back to
          // the static numbers in pulse-cities.ts without console spam.
          if (r.status === 404) {
            if (!cancelled) {
              setStats(null);
              setError(null);
            }
            return;
          }
          throw new Error(`HTTP ${r.status}`);
        }
        const payload = normalizeCityStatsPayload(await readBoundedJsonResponse(r, 256 * 1024));
        if (!payload) throw new Error("Malformed city stats response");
        if (cancelled) return;
        setStats(mapPayload(payload));
        setError(null);
      } catch (e: unknown) {
        if (cancelled) return;
        // AbortError from visibility/unmount is expected; don't surface it.
        const name = (e as { name?: string } | null)?.name;
        if (name === "AbortError" && !timedOut) return;
        if (timedOut) {
          setError("Request timed out");
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        window.clearTimeout(timeout);
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
