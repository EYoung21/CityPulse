"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, MapPin, Clock, Loader2, RefreshCw, Crosshair, Download, Code, Zap, Activity, Lock, Newspaper } from "lucide-react";
import {
  TIME_FILTERS,
  DEFAULT_TIME_FILTER_HOURS,
  LARGEST_FREE_TIME_FILTER_HOURS,
  sinceIsoForTimeFilterHours,
} from "@/lib/time-filters";
import IncidentFeed from "@/components/IncidentFeed";
import NewsroomDesk from "@/components/NewsroomDesk";
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
import { useMobilePrimaryTabSwipe } from "@/hooks/useMobilePrimaryTabSwipe";
import { activeNowCount } from "@/lib/analytics";
import AlertsInbox from "@/components/AlertsInbox";

function FeedAlertsInboxHost() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inbox = searchParams?.get("inbox");
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"list" | "settings">("list");

  useEffect(() => {
    if (inbox === "settings") {
      setPanel("settings");
      setOpen(true);
    } else if (inbox != null && inbox !== "") {
      setPanel("list");
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [inbox]);

  const onClose = useCallback(() => {
    setOpen(false);
    const p = new URLSearchParams(searchParams?.toString() ?? "");
    p.delete("inbox");
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : (pathname || "/feed"));
  }, [router, pathname, searchParams]);

  return (
    <>
      {open && (
        <button
          type="button"
          className="fixed inset-0 cursor-default border-0 p-0"
          style={{
            background: "var(--pp-overlay-medium)",
            zIndex: "var(--pp-z-mobile-overlay)",
          }}
          aria-label="Close alerts"
          onClick={onClose}
        />
      )}
      <AlertsInbox
        open={open}
        defaultPanel={panel}
        placement="mobileAboveNav"
        onClose={onClose}
        onJump={(incidentId, lat, lng) => {
          window.location.href = `/?incident=${encodeURIComponent(incidentId)}&lat=${lat}&lng=${lng}&zoom=16`;
        }}
      />
    </>
  );
}

/** `useSearchParams` + swipe hook — keep inside `<Suspense>` for App Router. */
function FeedMobileTabSwipeHost({ expandedId }: { expandedId: string | null }) {
  const searchParams = useSearchParams();
  const inboxOpen = searchParams.get("inbox");
  const enabled = useMemo(() => {
    if (typeof window === "undefined") return false;
    if (!window.matchMedia("(max-width: 767px)").matches) return false;
    if (inboxOpen != null && inboxOpen !== "") return false;
    if (expandedId) return false;
    return true;
  }, [inboxOpen, expandedId]);
  useMobilePrimaryTabSwipe({ enabled });
  return null;
}

export default function FeedPage() {
  const [mode, setMode] = useState<FeedMode>("recent");
  const [timeFilter, setTimeFilter] = useState(DEFAULT_TIME_FILTER_HOURS);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeCats, setActiveCats] = useState<Set<string>>(() => new Set());
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef<HTMLDivElement | null>(null);
  const [feedScrollRoot, setFeedScrollRoot] = useState<HTMLDivElement | null>(null);

  const city = getCurrentCity();
  const { isPro } = useAuth();

  const feedSinceIso = useMemo(() => {
    // Free accounts can look back up to the largest free window (3 days / 72h);
    // Pro keeps whatever (deeper) window is selected.
    const effectiveHours = isPro
      ? timeFilter
      : Math.min(timeFilter, LARGEST_FREE_TIME_FILTER_HOURS);
    return sinceIsoForTimeFilterHours(effectiveHours) ?? undefined;
  }, [isPro, timeFilter]);

  const {
    incidents,
    loading,
    error,
    hasMore,
    cursor,
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
    sinceIso: feedSinceIso,
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
    const root = feedScrollRoot;
    const node = sentinelRef.current;
    if (!root || !node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void loadMore();
        }
      },
      { root, rootMargin: "0px 0px 480px 0px" }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [loadMore, feedScrollRoot, visibleIncidents.length, hasMore, cursor, mode]);

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
              style={{ background: "var(--pp-accent-soft)", color: "var(--pp-accent)" }}
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
            <Link
              href="/more"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg shadow-purple-500/20"
              style={{ background: "linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)", color: "#fff" }}
            >
              <Zap className="w-3.5 h-3.5 fill-current" /> Upgrade
            </Link>
          )}
        </div>
      </header>

      <div
        className="px-3 py-2 overflow-x-auto no-scrollbar flex items-center gap-1 shrink-0"
        style={{ borderBottom: "1px solid var(--panel-border, rgba(148,163,184,0.15))" }}
      >
        <Clock className="w-3.5 h-3.5 shrink-0 ml-1" style={{ color: "var(--panel-text-muted)" }} />
        {TIME_FILTERS.map((tf) => {
          const locked = tf.pro && !isPro;
          return (
            <button
              key={tf.label}
              type="button"
              onClick={() => {
                if (locked) {
                  window.location.href = "/more";
                  return;
                }
                setTimeFilter(tf.hours);
              }}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium shrink-0 relative ${
                timeFilter === tf.hours ? "bg-blue-500/15 text-blue-500" : ""
              } ${locked ? "opacity-50" : ""}`}
              style={
                timeFilter !== tf.hours
                  ? { color: locked ? "var(--panel-text-muted)" : "var(--panel-text-secondary)" }
                  : undefined
              }
            >
              {tf.label}
              {locked && <Lock className="w-2.5 h-2.5 absolute -top-0.5 -right-0.5 text-purple-400" />}
            </button>
          );
        })}
      </div>

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
          <button
            type="button"
            role="tab"
            aria-selected={mode === "newsroom"}
            onClick={() => setMode("newsroom")}
            className="px-3 py-1 rounded-full font-medium flex items-center gap-1.5"
            style={{
              background: mode === "newsroom" ? "var(--panel-input-bg, rgba(148,163,184,0.15))" : "transparent",
              color: mode === "newsroom" ? "var(--panel-text)" : "var(--panel-text-muted)",
            }}
            title="Editor view: ranked, newsworthy incidents only"
          >
            <Newspaper className="w-3 h-3" /> Newsroom
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
        {visibleIncidents.length > 0 && mode !== "newsroom" && (
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

      {mode !== "newsroom" && (
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
      )}

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

        <FeedPullRefresh
          onRefresh={refresh}
          className="flex-1"
          onScroll={onScrollNearTop}
          onScrollContainerReady={setFeedScrollRoot}
        >
          <div ref={scrollTopRef}>
            {mode === "newsroom" ? (
              <NewsroomDesk
                incidents={incidents}
                onViewOnMap={handleViewOnMap}
                userLoc={userLoc}
                loading={loading}
              />
            ) : (
              <IncidentFeed
                incidents={visibleIncidents}
                selectedId={expandedId}
                onSelect={handleSelect}
                onViewOnMap={handleViewOnMap}
                showMapThumbnail
                density="immersive"
                loading={loading}
                sortMode={mode === "near" ? "near" : "recent"}
                userLoc={userLoc}
                newIncidentIds={newIncidentIds}
              />
            )}
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
      <Suspense fallback={null}>
        <FeedMobileTabSwipeHost expandedId={expandedId} />
        <FeedAlertsInboxHost />
      </Suspense>
      <InstallPrompt />
    </div>
  );
}
