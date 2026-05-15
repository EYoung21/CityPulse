"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, MapPin, Clock, Loader2, RefreshCw, Crosshair, Download, Code, Zap, Activity } from "lucide-react";
import IncidentFeed from "@/components/IncidentFeed";
import IncidentTypeFilterChips from "@/components/IncidentTypeFilterChips";
import { incidentMatchesCategoryFilter } from "@/lib/incident-category-groups";
import MobileBottomNav, { MOBILE_NAV_HEIGHT_PX } from "@/components/MobileBottomNav";
import InstallPrompt from "@/components/InstallPrompt";
import FeedPullRefresh from "@/components/FeedPullRefresh";
import FeedNewPill from "@/components/FeedNewPill";
import FeedAudioMiniPlayer from "@/components/FeedAudioMiniPlayer";
import { getCurrentCity } from "@/lib/pulse-cities";
import { useAuth } from "@/contexts/AuthContext";
import { useFeedIncidents, type FeedMode } from "@/hooks/useFeedIncidents";
import { activeNowCount } from "@/lib/analytics";

export default function FeedPage() {
  const [mode, setMode] = useState<FeedMode>("recent");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeCats, setActiveCats] = useState<Set<string>>(() => new Set());
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef<HTMLDivElement | null>(null);

  const city = getCurrentCity();
  const { isPro } = useAuth();
  const freeSinceIso = useMemo(
    () => new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    []
  );

  const {
    incidents,
    loading,
    error,
    hasMore,
    loadMore,
    refresh,
    userLoc,
    locating,
    requestLocation,
    lastUpdatedLabel,
    pendingNewCount,
    acknowledgeNew,
    onScrollNearTop,
  } = useFeedIncidents({
    citySlug: city.slug,
    mode,
    onModeChange: setMode,
    sinceIso: isPro ? undefined : freeSinceIso,
  });

  const visibleIncidents = useMemo(
    () => incidents.filter((i) => incidentMatchesCategoryFilter(i, activeCats)),
    [incidents, activeCats]
  );

  const newIncidentIds = useMemo(() => {
    if (pendingNewCount <= 0) return undefined;
    return new Set(incidents.slice(0, pendingNewCount).map((i) => i.id));
  }, [incidents, pendingNewCount]);

  const activeNow = useMemo(() => activeNowCount(visibleIncidents, 30), [visibleIncidents]);

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

  const handleSelect = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleViewOnMap = useCallback((id: string) => {
    if (typeof window === "undefined") return;
    window.location.href = `/?incident=${encodeURIComponent(id)}`;
  }, []);

  const headerSubtitle = useMemo(() => {
    if (lastUpdatedLabel) return lastUpdatedLabel;
    if (mode === "near" && userLoc) return "Closest incidents to you";
    return `Latest scanner activity in ${city.name}`;
  }, [mode, userLoc, city.name, lastUpdatedLabel]);

  const downloadCsv = useCallback(() => {
    if (visibleIncidents.length === 0) return;
    const escape = (s: string) => {
      if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const headers = ["reported_at", "category", "location", "lat", "lng", "description", "confidence"];
    const rows = visibleIncidents.map((inc) => [
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
  }, [visibleIncidents, city.slug]);

  const jumpToNew = useCallback(() => {
    acknowledgeNew();
    scrollTopRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [acknowledgeNew]);

  return (
    <div
      className="min-h-dvh flex flex-col"
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
          style={{ background: "var(--panel-input-bg, rgba(148,163,184,0.1))" }}
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
          {isPro ? (
            <Link
              href="/?view=analytics"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium"
              style={{ background: "rgba(59,130,246,0.12)", color: "#60a5fa" }}
            >
              <Activity className="w-3 h-3" />
              {activeNow} active
            </Link>
          ) : null}
          <Link
            href="/use-cases/api"
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
              onClick={() => { window.location.href = "/?view=map&inbox=settings"; }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg shadow-purple-500/20"
              style={{ background: "linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)", color: "#fff" }}
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
              else void requestLocation();
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
            onClick={() => void requestLocation()}
            className="ml-auto inline-flex items-center gap-1 text-[11px]"
            style={{ color: "var(--panel-text-muted)" }}
            title="Refresh your location"
          >
            <Crosshair className="w-3 h-3" /> Update location
          </button>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          className={`inline-flex items-center gap-1 text-[11px] ${mode === "near" ? "" : "ml-auto"}`}
          style={{ color: "var(--panel-text-muted)" }}
          title="Refresh feed"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
        {visibleIncidents.length > 0 && (
          <button
            type="button"
            onClick={downloadCsv}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors hover:bg-white/5"
            style={{ color: "var(--panel-text-muted)", border: "1px solid var(--panel-border)" }}
            title={`Download ${visibleIncidents.length} incidents as CSV`}
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
        )}
      </div>

      <div
        className="px-4 py-2 flex flex-wrap items-center gap-2"
        style={{ borderBottom: "1px solid var(--panel-border, rgba(148,163,184,0.15))" }}
      >
        <IncidentTypeFilterChips
          activeCats={activeCats}
          onActiveCatsChange={setActiveCats}
          incidentsForCounts={incidents}
        />
      </div>

      {!isPro && (
        <div className="px-4 py-2 text-[10px] md:text-xs font-medium flex items-center justify-center gap-2 bg-purple-500/10 border-y border-purple-500/20 text-purple-400">
          <Zap className="w-3 h-3 fill-current" />
          Showing last 60 minutes of activity. Upgrade to Pro for full history.
        </div>
      )}

      <FeedNewPill count={pendingNewCount} onJump={jumpToNew} />
      <FeedAudioMiniPlayer />

      <main className="flex-1 min-h-0 flex flex-col">
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

        <FeedPullRefresh onRefresh={refresh} className="flex-1" onScroll={onScrollNearTop}>
          <div ref={scrollTopRef}>
            <IncidentFeed
              incidents={visibleIncidents}
              selectedId={expandedId}
              onSelect={handleSelect}
              onViewOnMap={handleViewOnMap}
              showMapThumbnail
              density="immersive"
              loading={loading}
              sortMode={mode}
              userLoc={userLoc}
              newIncidentIds={newIncidentIds}
            />
            <div ref={sentinelRef} className="h-12" />
            {!hasMore && mode === "recent" && visibleIncidents.length > 0 && (
              <div className="px-4 py-6 text-center text-[11px]" style={{ color: "var(--panel-text-muted)" }}>
                That&apos;s every incident in your selected window.
              </div>
            )}
            <div
              aria-hidden="true"
              style={{ height: `calc(${MOBILE_NAV_HEIGHT_PX}px + env(safe-area-inset-bottom, 0px))` }}
            />
          </div>
        </FeedPullRefresh>
      </main>
      <MobileBottomNav />
      <InstallPrompt />
    </div>
  );
}
