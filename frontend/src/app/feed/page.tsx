"use client";

/**
 * Full-screen `/feed` route.
 *
 * Citizen-style infinite-scroll incident feed, no map. We deliberately
 * keep it as a *separate route* from the map-first home (`/`) so:
 *   - users on the home page get the full map experience untouched
 *   - users who prefer the feed can pin /feed as their home tab
 *   - the design door is open to making /feed the mobile default later
 *
 * Two browse modes:
 *   - "Recent": cursor-paginated chronological order, time-bucketed.
 *   - "Near me": proximity-sorted (requires geolocation). No paginated
 *     cursor — the server returns the closest N to keep results
 *     predictable when you scroll back to the top.
 *
 * Each incident row links into the existing map view via `?incident=…`
 * so tapping a row gives the user the same detail panel they'd see if
 * they had been on the map all along.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, MapPin, Clock, Loader2, RefreshCw, Map as MapIcon, Crosshair, Download, Code, Zap } from "lucide-react";
import IncidentFeed from "@/components/IncidentFeed";
import MobileBottomNav, { MOBILE_NAV_HEIGHT_PX } from "@/components/MobileBottomNav";
import { fetchIncidentPage, type Incident } from "@/lib/api";
import { fetchIncidentPageFromFirestore } from "@/lib/firestore";
import { getCurrentCity } from "@/lib/pulse-cities";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Read-path resolver for the feed: Firestore first (resilient to the
 * Python API being down), API as a fallback (covers the case where
 * Firestore is misconfigured locally but the dev server is fine).
 *
 * The Python `/api/incidents/page` endpoint and the Firestore query
 * return the same shape, so the caller can't tell them apart. The
 * fallback mostly matters for local dev with `NEXT_PUBLIC_FIREBASE_*`
 * unset; in prod, Firestore should always succeed.
 */
async function loadIncidentPage(opts: {
  cursor?: string | null;
  limit?: number;
  city?: string;
  nearLat?: number | null;
  nearLng?: number | null;
  since?: string;
  signal?: AbortSignal;
}) {
  try {
    return await fetchIncidentPageFromFirestore(opts);
  } catch (firestoreErr) {
    console.warn("[feed] Firestore page failed, falling back to API", firestoreErr);
    return fetchIncidentPage(opts);
  }
}

type FeedMode = "recent" | "near";

const PAGE_SIZE = 20;

export default function FeedPage() {
  const [mode, setMode] = useState<FeedMode>("recent");
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userLoc, setUserLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const city = getCurrentCity();
  const { isPro } = useAuth();
  const freeSinceIso = useMemo(
    () => new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    []
  );

  /** First-page load + reload on mode change. */
  const loadFirst = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    setIncidents([]);
    setCursor(null);
    setHasMore(true);
    let timedOut = false;
    const slow = window.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, 25_000);
    try {
      const page = await loadIncidentPage({
        limit: mode === "near" ? 40 : PAGE_SIZE,
        city: city.slug,
        nearLat: mode === "near" ? userLoc?.lat ?? null : null,
        nearLng: mode === "near" ? userLoc?.lng ?? null : null,
        since: isPro ? undefined : freeSinceIso,
        signal: ctrl.signal,
      });
      if (!ctrl.signal.aborted) {
        setIncidents(page.incidents);
        setCursor(page.next_cursor);
        setHasMore(Boolean(page.next_cursor));
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
  }, [mode, city.slug, userLoc?.lat, userLoc?.lng]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  /** Cursor pagination — only meaningful in "recent" mode. */
  const loadMore = useCallback(async () => {
    if (!cursor || loading || !hasMore || mode !== "recent") return;
    setLoading(true);
    try {
      const page = await loadIncidentPage({
        cursor,
        limit: PAGE_SIZE,
        city: city.slug,
      });
      setIncidents((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        const merged = [...prev];
        for (const inc of page.incidents) {
          if (!seen.has(inc.id)) merged.push(inc);
        }
        return merged;
      });
      setCursor(page.next_cursor);
      setHasMore(Boolean(page.next_cursor));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, hasMore, mode, city.slug]);

  /** Intersection-observer-driven autoload for the bottom sentinel. */
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void loadMore();
        }
      },
      { rootMargin: "400px 0px" }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [loadMore]);

  const requestLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setError("Geolocation is not supported in this browser");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setMode("near");
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setError(err.message || "Could not get your location");
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    );
  }, []);

  /** Hook into the map view: tapping a row deep-links into `/?incident=ID`
   *  so the existing map detail panel renders the selection. */
  const handleSelect = useCallback((id: string) => {
    if (typeof window === "undefined") return;
    window.location.href = `/?incident=${encodeURIComponent(id)}`;
  }, []);

  const headerSubtitle = useMemo(() => {
    if (mode === "near" && userLoc) return "Closest incidents to you";
    return `Latest scanner activity in ${city.name}`;
  }, [mode, userLoc, city.name]);

  /** Download currently loaded incidents as a CSV file. */
  const downloadCsv = useCallback(() => {
    if (incidents.length === 0) return;
    const escape = (s: string) => {
      if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const headers = ["reported_at", "category", "location", "lat", "lng", "description", "confidence"];
    const rows = incidents.map((inc) => [
      inc.reported_at,
      inc.severity_category,
      escape(inc.location_text || ""),
      String(inc.lat ?? ""),
      String(inc.lng ?? ""),
      escape(inc.description || ""),
      String(Math.round(inc.confidence * 100)),
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `citypulse-${city.slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [incidents, city.slug]);

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "var(--page-bg, #0b1120)", color: "var(--panel-text, #e2e8f0)" }}
    >
      <header
        className="sticky top-0 z-20 px-4 py-3 flex items-center gap-3"
        style={{
          background: "var(--panel-bg, rgba(15,23,42,0.95))",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid var(--panel-border, rgba(148,163,184,0.2))",
        }}
      >
        <Link
          href="/?view=map"
          className="inline-flex items-center justify-center w-9 h-9 rounded-full"
          style={{
            background: "var(--panel-input-bg, rgba(148,163,184,0.1))",
          }}
          aria-label="Back to map"
          title="Back to map"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold truncate">Feed</h1>
          <p className="text-xs truncate" style={{ color: "var(--panel-text-muted, #94a3b8)" }}>
            {headerSubtitle}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/api-docs"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all hover:bg-white/10"
            style={{
              background: "rgba(148,163,184,0.1)",
              color: "var(--panel-text-secondary)",
              border: "1px solid rgba(148,163,184,0.2)",
            }}
          >
            <Code className="w-3.5 h-3.5" /> API
          </Link>
          {!isPro && (
            <button
              onClick={() => window.location.href = "/?view=map&inbox=settings"}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg shadow-purple-500/20"
              style={{
                background: "linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)",
                color: "#fff",
              }}
            >
              <Zap className="w-3.5 h-3.5 fill-current" /> Upgrade
            </button>
          )}
        </div>
      </header>

      <div
        className="px-4 py-2 flex items-center gap-2"
        style={{ borderBottom: "1px solid var(--panel-border, rgba(148,163,184,0.15))" }}
      >
        <div
          className="inline-flex rounded-full p-0.5 text-xs"
          style={{
            background: "var(--panel-bg-secondary, rgba(30,41,59,0.5))",
            border: "1px solid var(--panel-border, rgba(148,163,184,0.2))",
          }}
          role="tablist"
          aria-label="Feed mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "recent"}
            onClick={() => setMode("recent")}
            className="px-3 py-1 rounded-full font-medium flex items-center gap-1.5"
            style={{
              background: mode === "recent" ? "var(--panel-input-bg, rgba(148,163,184,0.15))" : "transparent",
              color: mode === "recent" ? "var(--panel-text)" : "var(--panel-text-muted)",
            }}
          >
            <Clock className="w-3 h-3" /> Recent
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "near"}
            onClick={() => {
              if (userLoc) setMode("near");
              else requestLocation();
            }}
            disabled={locating}
            className="px-3 py-1 rounded-full font-medium flex items-center gap-1.5 disabled:opacity-60"
            style={{
              background: mode === "near" ? "var(--panel-input-bg, rgba(148,163,184,0.15))" : "transparent",
              color: mode === "near" ? "var(--panel-text)" : "var(--panel-text-muted)",
            }}
          >
            {locating ? <Loader2 className="w-3 h-3 animate-spin" /> : <MapPin className="w-3 h-3" />}
            Near me
          </button>
        </div>
        {mode === "near" && userLoc && (
          <button
            type="button"
            onClick={requestLocation}
            className="ml-auto inline-flex items-center gap-1 text-[11px]"
            style={{ color: "var(--panel-text-muted)" }}
            title="Refresh your location"
          >
            <Crosshair className="w-3 h-3" /> Update location
          </button>
        )}
        <button
          type="button"
          onClick={() => void loadFirst()}
          className={`inline-flex items-center gap-1 text-[11px] ${mode === "near" ? "" : "ml-auto"}`}
          style={{ color: "var(--panel-text-muted)" }}
          title="Refresh feed"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
        {incidents.length > 0 && (
          <button
            type="button"
            onClick={downloadCsv}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors hover:bg-white/5"
            style={{ color: "var(--panel-text-muted)", border: "1px solid var(--panel-border)" }}
            title={`Download ${incidents.length} incidents as CSV`}
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
        )}
      </div>

      {!isPro && (
        <div className="px-4 py-2 text-[10px] md:text-xs font-medium flex items-center justify-center gap-2 bg-purple-500/10 border-y border-purple-500/20 text-purple-400">
          <Zap className="w-3 h-3 fill-current" />
          Showing last 60 minutes of activity. Upgrade to Pro for full history.
        </div>
      )}

      <main className="flex-1">
        {error && (
          <div
            className="mx-4 mt-3 px-3 py-2 rounded-lg text-xs"
            style={{
              background: "rgba(239,68,68,0.12)",
              color: "#ef4444",
              border: "1px solid rgba(239,68,68,0.3)",
            }}
          >
            {error}
          </div>
        )}

        <IncidentFeed
          incidents={incidents}
          selectedId={null}
          onSelect={handleSelect}
          showMapThumbnail
        />

        <div ref={sentinelRef} className="h-12" />
        {loading && (
          <div className="flex items-center justify-center py-4 text-xs" style={{ color: "var(--panel-text-muted)" }}>
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Loading…
          </div>
        )}
        {!hasMore && mode === "recent" && incidents.length > 0 && (
          <div className="px-4 py-6 text-center text-[11px]" style={{ color: "var(--panel-text-muted)" }}>
            That&apos;s every incident in your selected window.
          </div>
        )}
        {/* Padding the scroll list so the last incident row clears
            the fixed bottom nav on mobile (the nav is `position:
            fixed` so it overlays content otherwise). Sized at the
            nav height + iOS home-indicator inset; harmless on
            desktop where the nav itself renders nothing. */}
        <div
          aria-hidden="true"
          style={{
            height: `calc(${MOBILE_NAV_HEIGHT_PX}px + env(safe-area-inset-bottom, 0px))`,
          }}
        />
      </main>
      <MobileBottomNav />
    </div>
  );
}
