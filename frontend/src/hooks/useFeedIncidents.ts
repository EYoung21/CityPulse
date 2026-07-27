"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchIncidentPage, fetchIncidentWindow, type Incident } from "@/lib/api";
import { loadCachedIncidents } from "@/lib/incident-snapshot-cache";
import { getCurrentPosition } from "@/lib/native";

export type FeedMode = "recent" | "near" | "newsroom";

// Newsroom ranks a window of incidents, so it pulls a deeper first page than
// the scrolling feed — enough pool to triage + compute the "unusual for the
// area" baseline.
const NEWSROOM_FIRST_PAGE = 200;

const PAGE_SIZE = 20;

async function loadIncidentPage(opts: {
  cursor?: string | null;
  limit?: number;
  city?: string;
  nearLat?: number | null;
  nearLng?: number | null;
  since?: string;
  signal?: AbortSignal;
}) {
  return fetchIncidentPage(opts);
}

function mergeUnique(prev: Incident[], incoming: Incident[]): Incident[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map((i) => i.id));
  const merged = [...prev];
  for (const inc of incoming) {
    if (!seen.has(inc.id)) {
      seen.add(inc.id);
      merged.push(inc);
    }
  }
  return merged;
}

function prependUnique(prev: Incident[], incoming: Incident[]): Incident[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map((i) => i.id));
  const fresh: Incident[] = [];
  for (const inc of incoming) {
    if (!seen.has(inc.id)) {
      seen.add(inc.id);
      fresh.push(inc);
    }
  }
  if (fresh.length === 0) return prev;
  return [...fresh, ...prev];
}

export function filterIncidentsSince(rows: Incident[], sinceIso?: string): Incident[] {
  if (!sinceIso) return rows;
  const boundary = Date.parse(sinceIso);
  if (!Number.isFinite(boundary)) return rows;
  return rows.filter((incident) => Date.parse(incident.reported_at) >= boundary);
}

export interface UseFeedIncidentsOptions {
  citySlug: string;
  mode: FeedMode;
  onModeChange?: (mode: FeedMode) => void;
  sinceIso?: string;
  enableLive?: boolean;
  pageSize?: number;
}

export function useFeedIncidents({
  citySlug,
  mode,
  onModeChange,
  sinceIso,
  enableLive = true,
  pageSize = PAGE_SIZE,
}: UseFeedIncidentsOptions) {
  const [incidents, setIncidents] = useState<Incident[]>(() => {
    if (typeof window === "undefined") return [];
    const cached = loadCachedIncidents(citySlug);
    return cached ? filterIncidentsSince(cached.incidents, sinceIso).slice(0, pageSize) : [];
  });
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userLoc, setUserLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    return loadCachedIncidents(citySlug)?.savedAt ?? null;
  });
  const [pendingNewCount, setPendingNewCount] = useState(0);
  const [newIncidentIds, setNewIncidentIds] = useState<Set<string> | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const newestAtRef = useRef<number>(0);
  const userScrolledDownRef = useRef(false);
  const pendingBufferRef = useRef<Incident[]>([]);
  const newHighlightTimerRef = useRef<number | null>(null);

  const highlightNew = useCallback((rows: Incident[]) => {
    if (rows.length === 0) return;
    setNewIncidentIds(new Set(rows.map((incident) => incident.id)));
    if (newHighlightTimerRef.current != null) {
      window.clearTimeout(newHighlightTimerRef.current);
    }
    newHighlightTimerRef.current = window.setTimeout(() => {
      setNewIncidentIds(undefined);
      newHighlightTimerRef.current = null;
    }, 10_000);
  }, []);

  const markKnown = useCallback((rows: Incident[]) => {
    for (const inc of rows) knownIdsRef.current.add(inc.id);
    const top = rows[0];
    if (top) {
      const t = Date.parse(top.reported_at);
      if (Number.isFinite(t)) newestAtRef.current = Math.max(newestAtRef.current, t);
    }
  }, []);

  const loadFirst = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    setCursor(null);
    setHasMore(true);
    setPendingNewCount(0);
    setNewIncidentIds(undefined);
    pendingBufferRef.current = [];
    userScrolledDownRef.current = false;

    const cached = loadCachedIncidents(citySlug);
    const cachedRows = cached ? filterIncidentsSince(cached.incidents, sinceIso) : [];
    if (cached && cachedRows.length > 0) {
      const slice = cachedRows.slice(0, pageSize);
      setIncidents(slice);
      knownIdsRef.current = new Set(slice.map((i) => i.id));
      const top = slice[0];
      if (top) {
        const t = Date.parse(top.reported_at);
        if (Number.isFinite(t)) newestAtRef.current = t;
      }
      setLastUpdatedAt(cached.savedAt);
    } else {
      setIncidents([]);
      knownIdsRef.current = new Set();
      newestAtRef.current = 0;
    }

    let timedOut = false;
    const slow = window.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, 25_000);

    try {
      const page = mode === "newsroom"
        ? {
            incidents: await fetchIncidentWindow({
              city: citySlug,
              since: sinceIso,
              maxRows: NEWSROOM_FIRST_PAGE,
              signal: ctrl.signal,
            }),
            next_cursor: null,
            mode: "recent" as const,
          }
        : await loadIncidentPage({
            limit: mode === "near" ? Math.max(pageSize, 40) : pageSize,
            city: citySlug,
            nearLat: mode === "near" ? userLoc?.lat ?? null : null,
            nearLng: mode === "near" ? userLoc?.lng ?? null : null,
            since: sinceIso,
            signal: ctrl.signal,
          });
      if (!ctrl.signal.aborted) {
        setIncidents(page.incidents);
        markKnown(page.incidents);
        setCursor(page.next_cursor);
        setHasMore(Boolean(page.next_cursor));
        setLastUpdatedAt(Date.now());
      }
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      if (aborted && timedOut) {
        setError("Request timed out — check your connection and try again.");
      } else if (!aborted) {
        setError(err instanceof Error ? err.message : "Failed to load feed");
      }
    } finally {
      window.clearTimeout(slow);
      setLoading(false);
    }
  }, [citySlug, markKnown, mode, pageSize, sinceIso, userLoc?.lat, userLoc?.lng]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading || !hasMore || mode === "near") return;
    setLoading(true);
    try {
      const page = await loadIncidentPage({
        cursor,
        limit: pageSize,
        city: citySlug,
        since: sinceIso,
      });
      setIncidents((prev) => {
        const merged = mergeUnique(prev, page.incidents);
        markKnown(page.incidents);
        return merged;
      });
      setCursor(page.next_cursor);
      setHasMore(Boolean(page.next_cursor));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoading(false);
    }
  }, [cursor, citySlug, hasMore, loading, markKnown, mode, pageSize, sinceIso]);

  const refresh = useCallback(async () => {
    await loadFirst();
  }, [loadFirst]);

  const requestLocation = useCallback(async () => {
    setLocating(true);
    setError(null);
    try {
      const pos = await getCurrentPosition();
      setUserLoc({ lat: pos.lat, lng: pos.lng });
      onModeChange?.("near");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not get your location");
    } finally {
      setLocating(false);
    }
  }, [onModeChange]);

  const acknowledgeNew = useCallback(() => {
    const pending = pendingBufferRef.current;
    if (pending.length > 0) {
      setIncidents((prev) => prependUnique(prev, pending));
      setLastUpdatedAt(Date.now());
      highlightNew(pending);
    }
    pendingBufferRef.current = [];
    setPendingNewCount(0);
    userScrolledDownRef.current = false;
  }, [highlightNew]);

  const onScrollNearTop = useCallback((nearTop: boolean) => {
    userScrolledDownRef.current = !nearTop;
    if (nearTop) acknowledgeNew();
  }, [acknowledgeNew]);

  useEffect(() => () => {
    if (newHighlightTimerRef.current != null) {
      window.clearTimeout(newHighlightTimerRef.current);
    }
  }, []);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  useEffect(() => {
    if (!enableLive || mode === "near") return;
    const controller = new AbortController();
    let cancelled = false;
    const poll = async () => {
      try {
        const page = await fetchIncidentPage({
          city: citySlug,
          since: sinceIso,
          limit: 50,
          signal: controller.signal,
        });
        if (cancelled) return;
        const fresh = page.incidents.filter((inc) => {
          if (knownIdsRef.current.has(inc.id)) return false;
          const t = Date.parse(inc.reported_at);
          return Number.isFinite(t) && t >= newestAtRef.current;
        });
        if (fresh.length === 0) return;
        fresh.sort((a, b) => Date.parse(b.reported_at) - Date.parse(a.reported_at));
        markKnown(fresh);
        if (userScrolledDownRef.current) {
          pendingBufferRef.current = prependUnique(pendingBufferRef.current, fresh);
          setPendingNewCount(pendingBufferRef.current.length);
        } else {
          setIncidents((prev) => prependUnique(prev, fresh));
          setLastUpdatedAt(Date.now());
          highlightNew(fresh);
        }
      } catch (error) {
        if (!cancelled && (error as { name?: string })?.name !== "AbortError") {
          console.warn("[feed] Live poll failed", error);
        }
      }
    };
    const timer = window.setInterval(poll, 12_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [citySlug, enableLive, highlightNew, markKnown, mode, pageSize, sinceIso]);

  const lastUpdatedLabel = useMemo(() => {
    if (!lastUpdatedAt) return null;
    const diff = Date.now() - lastUpdatedAt;
    if (diff < 60_000) return "Updated just now";
    const mins = Math.floor(diff / 60_000);
    return `Updated ${mins}m ago`;
  }, [lastUpdatedAt]);

  return {
    incidents,
    loading,
    error,
    hasMore,
    cursor,
    loadFirst,
    loadMore,
    refresh,
    userLoc,
    locating,
    requestLocation,
    lastUpdatedAt,
    lastUpdatedLabel,
    pendingNewCount,
    newIncidentIds,
    acknowledgeNew,
    onScrollNearTop,
  };
}
