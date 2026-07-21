"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import {
  X,
  TrendingUp,
  TrendingDown,
  Grid3X3,
  BarChart3,
  ExternalLink,
  Download,
  Camera,
  MapPin,
  Activity,
  Layers as LayersIcon,
  Clock,
  Database,
  Radio,
  Moon,
  Sun,
  ChevronDown,
} from "lucide-react";
import type { Incident } from "@/lib/api";
import {
  trendByDay,
  timeGrid,
  areaVsCityComparison,
  hourDistribution,
  bestTravelWindow,
  withinWindow,
  severityIndexByDay,
  categoryWoW,
  severityBucketMix,
  topHotspots,
  dayNightByBucket,
  feedMix,
  dataQuality,
  activeNowCount,
  calendarGrid,
  categoryDisplay,
  incidentsToCsv,
  mentionVelocity,
  confidenceTrend,
  inhibitorTrend,
  feedMixWeighted,
  geoDensityGrid,
  routeSafetyByHour,
  incidentsNearRoute,
} from "@/lib/analytics";
import Sparkline from "@/components/charts/Sparkline";
import TimeGrid from "@/components/charts/TimeGrid";
import DonutChart from "@/components/charts/DonutChart";
import CalendarHeatmap from "@/components/charts/CalendarHeatmap";
import {
  type District,
  getDistrictsForCity,
  incidentsInDistrict,
  onCityDistrictsLoaded,
} from "@/lib/districts";
import {
  type Neighborhood,
  getNeighborhoodsForCity,
  incidentsInNeighborhood,
  onCityNeighborhoodsLoaded,
} from "@/lib/neighborhoods";
import { getCurrentCity } from "@/lib/pulse-cities";
import IncidentTypeFilterChips from "@/components/IncidentTypeFilterChips";

type TabId = "overview" | "hotspots" | "categories" | "timing" | "quality" | "routes";
type ScopeKind = "city" | "district" | "neighborhood";

const TIME_WINDOWS: { label: string; hours: number }[] = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
  { label: "90d", hours: 24 * 90 },
  { label: "All", hours: Infinity },
];

const TABS: { id: TabId; label: string; Icon: typeof BarChart3 }[] = [
  { id: "overview",   label: "Overview",     Icon: BarChart3 },
  { id: "hotspots",   label: "Hotspots",     Icon: MapPin },
  { id: "categories", label: "Categories",   Icon: LayersIcon },
  { id: "timing",     label: "Timing",       Icon: Clock },
  { id: "quality",    label: "Data quality", Icon: Database },
  { id: "routes",     label: "Routes",       Icon: Activity },
];

interface Props {
  /** All incidents the page currently has loaded (already trimmed to whatever
   *  the page-level extended-history fetch returned). The panel applies its
   *  own time-window filter on top. */
  incidents: Incident[];
  /** Optional pre-scoped slice (e.g. tap-area). When present and non-empty,
   *  acts as a permanent override for the scope selector. */
  areaIncidents?: Incident[];
  areaName?: string;
  /** Lookup so the Feeds breakdown can show pretty names instead of raw ids. */
  feedLabels?: Record<string, string>;
  routeGeometry?: [number, number][];
  onClose: () => void;
  /** When set with `onActiveCatsChange`, mirrors the map feed category filter
   *  (empty set = all types). */
  activeCats?: Set<string>;
  onActiveCatsChange?: Dispatch<SetStateAction<Set<string>>>;
}

export default function AnalyticsPanel({
  incidents,
  areaIncidents,
  areaName,
  feedLabels = {},
  routeGeometry,
  onClose,
  activeCats: activeCatsProp,
  onActiveCatsChange,
}: Props) {
  const [localCats, setLocalCats] = useState<Set<string>>(() => new Set());
  const activeCats = activeCatsProp ?? localCats;
  const setActiveCats = onActiveCatsChange ?? setLocalCats;

  const [windowHours, setWindowHours] = useState<number>(24 * 30);
  const [tab, setTab] = useState<TabId>("overview");
  const [scopeKind, setScopeKind] = useState<ScopeKind>("city");
  // User's *intent*. The actual slug used downstream is `effectiveScopeSlug`,
  // which falls back to the first available entry when the user's pick is
  // missing for the current city — keeps the effect-free derived-state pattern.
  const [requestedScopeSlug, setRequestedScopeSlug] = useState<string | null>(null);
  // Re-render trigger when lazy district/neighborhood JSON loads after mount.
  const [, setRegistryTick] = useState(0);
  const exportTargetRef = useRef<HTMLDivElement | null>(null);

  const citySlug = useMemo(() => {
    if (typeof window === "undefined") return "";
    return getCurrentCity().slug;
  }, []);

  useEffect(() => {
    const offD = onCityDistrictsLoaded((slug) => {
      if (slug === citySlug) setRegistryTick((t) => t + 1);
    });
    const offN = onCityNeighborhoodsLoaded((slug) => {
      if (slug === citySlug) setRegistryTick((t) => t + 1);
    });
    return () => {
      offD();
      offN();
    };
  }, [citySlug]);

  const districts: District[] = useMemo(
    () => getDistrictsForCity(citySlug),
    [citySlug]
  );
  const neighborhoods: Neighborhood[] = useMemo(
    () => getNeighborhoodsForCity(citySlug),
    [citySlug]
  );

  // Resolve the *effective* scope slug from the user's intent + current
  // registry contents. Pure derivation (no setState in an effect) so we
  // automatically heal when lazy district/neighborhood JSON loads later.
  const effectiveScopeSlug = useMemo<string | null>(() => {
    if (scopeKind === "city") return null;
    const list = scopeKind === "district" ? districts : neighborhoods;
    if (list.length === 0) return null;
    if (requestedScopeSlug && list.some((x) => x.slug === requestedScopeSlug)) {
      return requestedScopeSlug;
    }
    return list[0].slug;
  }, [scopeKind, districts, neighborhoods, requestedScopeSlug]);

  // Resolve the working slice. Priority:
  //   1. Caller-provided areaIncidents (e.g. tap-area).
  //   2. Selected district / neighborhood.
  //   3. All incidents.
  const scopedAll = useMemo(() => {
    if (areaIncidents && areaIncidents.length > 0) return areaIncidents;
    if (scopeKind === "district" && effectiveScopeSlug) {
      return incidentsInDistrict(incidents, effectiveScopeSlug);
    }
    if (scopeKind === "neighborhood" && effectiveScopeSlug) {
      return incidentsInNeighborhood(incidents, effectiveScopeSlug);
    }
    return incidents;
  }, [areaIncidents, scopeKind, effectiveScopeSlug, incidents]);

  const scopeLabel = useMemo(() => {
    if (areaIncidents && areaIncidents.length > 0 && areaName) return areaName;
    if (scopeKind === "district") {
      return districts.find((d) => d.slug === effectiveScopeSlug)?.name ?? "District";
    }
    if (scopeKind === "neighborhood") {
      return neighborhoods.find((n) => n.slug === effectiveScopeSlug)?.name ?? "Neighborhood";
    }
    return areaName ?? "City";
  }, [areaIncidents, areaName, scopeKind, effectiveScopeSlug, districts, neighborhoods]);

  // Apply the time window AFTER the scope filter so all derived charts agree.
  const timeWindowed = useMemo(() => withinWindow(scopedAll, windowHours), [scopedAll, windowHours]);
  const cityTimeWindowed = useMemo(() => withinWindow(incidents, windowHours), [incidents, windowHours]);

  const scoped = useMemo(() => {
    if (activeCats.size === 0) return timeWindowed;
    return timeWindowed.filter((i) => activeCats.has(i.severity_category));
  }, [timeWindowed, activeCats]);

  const cityWindowed = useMemo(() => {
    if (activeCats.size === 0) return cityTimeWindowed;
    return cityTimeWindowed.filter((i) => activeCats.has(i.severity_category));
  }, [cityTimeWindowed, activeCats]);

  const emptyBecauseCategoryOnly =
    timeWindowed.length > 0 && scoped.length === 0 && activeCats.size > 0;

  // ── Derived stats ──────────────────────────────────────────────────────
  const trends = useMemo(() => trendByDay(scoped, 30), [scoped]);
  const grid = useMemo(() => timeGrid(scoped), [scoped]);
  const comparison = useMemo(
    () => (scoped !== cityWindowed ? areaVsCityComparison(scoped, cityWindowed) : null),
    [scoped, cityWindowed]
  );
  const hours = useMemo(() => hourDistribution(scoped), [scoped]);
  const quietWindow = useMemo(() => bestTravelWindow(hours), [hours]);
  const sevIndex = useMemo(() => severityIndexByDay(scoped, 30), [scoped]);
  const wow = useMemo(() => categoryWoW(scoped, windowHours), [scoped, windowHours]);
  const mix = useMemo(() => severityBucketMix(scoped), [scoped]);
  const hotspots = useMemo(() => topHotspots(scoped, 10), [scoped]);
  const dayNight = useMemo(() => dayNightByBucket(scoped), [scoped]);
  const feeds = useMemo(() => feedMix(scoped, feedLabels), [scoped, feedLabels]);
  const quality = useMemo(() => dataQuality(scoped), [scoped]);
  const activeNow = useMemo(() => activeNowCount(scoped, 30), [scoped]);
  const calendar = useMemo(() => calendarGrid(scoped, 12), [scoped]);
  const mentions = useMemo(() => mentionVelocity(scoped, Number.isFinite(windowHours) ? windowHours : 24 * 7), [scoped, windowHours]);
  const confTrend = useMemo(() => confidenceTrend(scoped, 14), [scoped]);
  const inhibTrend = useMemo(() => inhibitorTrend(scoped, 14), [scoped]);
  const feedsWeighted = useMemo(() => feedMixWeighted(scoped, feedLabels), [scoped, feedLabels]);
  const geoCells = useMemo(() => geoDensityGrid(scoped, 2).slice(0, 12), [scoped]);
  const routeHours = useMemo(
    () => (routeGeometry && routeGeometry.length > 1 ? routeSafetyByHour(routeGeometry, scoped) : null),
    [routeGeometry, scoped]
  );
  const routeIncidents = useMemo(
    () => (routeGeometry && routeGeometry.length > 1 ? incidentsNearRoute(routeGeometry, scoped).slice(0, 8) : []),
    [routeGeometry, scoped]
  );

  const totalCount = scoped.length;
  const sevSum = useMemo(() => sevIndex.reduce((s, v) => s + v, 0), [sevIndex]);

  // ── Export handlers ────────────────────────────────────────────────────
  const handleCsv = () => {
    const csv = incidentsToCsv(scoped);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const slug = (scopeLabel || "city").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const win = TIME_WINDOWS.find((w) => w.hours === windowHours)?.label || "all";
    const cat =
      activeCats.size > 0
        ? `-${[...activeCats].sort().join("+").slice(0, 40).replace(/[^a-z0-9+]+/gi, "-")}`
        : "";
    a.href = url;
    a.download = `citypulse-${slug}-${win}${cat}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePngExport = async () => {
    const node = exportTargetRef.current;
    if (!node) return;
    try {
      // Fall back to printing the SVG if html2canvas isn't bundled.
      const svgs = node.querySelectorAll("svg");
      if (svgs.length === 0) return;
      const first = svgs[0];
      const xml = new XMLSerializer().serializeToString(first);
      const blob = new Blob([xml], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `citypulse-chart-${Date.now()}.svg`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* swallow — export is best-effort */
    }
  };

  // ── Click-through helpers ──────────────────────────────────────────────
  const dispatchScope = (detail: Record<string, unknown>) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("pp:analytics-scope", { detail }));
  };

  const focusDistrict = (slug: string) => {
    dispatchScope({ kind: "district", slug });
  };
  const focusNeighborhood = (slug: string) => {
    dispatchScope({ kind: "neighborhood", slug });
  };
  const focusPoint = (lat: number, lng: number) => {
    dispatchScope({ kind: "point", lat, lng });
  };

  return (
    <div
      className="rounded-xl overflow-hidden backdrop-blur-xl shadow-2xl"
      style={{ background: "var(--panel-bg)", border: "1px solid var(--panel-border)" }}
    >
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-4 py-3 flex-wrap gap-2"
        style={{ borderBottom: "1px solid var(--panel-border)" }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <h3
            className="text-base font-semibold flex items-center gap-2"
            style={{ color: "var(--panel-text)" }}
          >
            <BarChart3 className="w-5 h-5 text-blue-500" />
            <span className="truncate">{scopeLabel} Analytics</span>
          </h3>
          <Link
            href="/use-cases/api"
            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-colors hover:bg-blue-500/10"
            style={{ border: "1px solid rgba(59,130,246,0.3)", color: "#3b82f6" }}
          >
            Developer API
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button"
            onClick={handleCsv}
            title="Export current scope as CSV"
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-medium hover:bg-white/5 transition-colors"
            style={{ color: "var(--panel-text-secondary)", border: "1px solid var(--panel-border)" }}
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>
          <button type="button"
            onClick={handlePngExport}
            title="Export visible chart as SVG"
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-medium hover:bg-white/5 transition-colors"
            style={{ color: "var(--panel-text-secondary)", border: "1px solid var(--panel-border)" }}
          >
            <Camera className="w-3.5 h-3.5" />
            SVG
          </button>
          <button type="button"
            onClick={onClose}
            className="p-1.5 transition-colors"
            style={{ color: "var(--panel-text-muted)" }}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* ── Scope + window controls ───────────────────────────────────── */}
      <div
        className="px-4 py-2.5 flex flex-wrap items-center gap-2"
        style={{ borderBottom: "1px solid var(--panel-border)" }}
      >
        <div
          className="inline-flex rounded-full p-0.5 text-[11px]"
          style={{ background: "var(--panel-input-bg)", border: "1px solid var(--panel-border)" }}
          role="group"
          aria-label="Analytics scope"
        >
          {(["city", "district", "neighborhood"] as ScopeKind[]).map((k) => {
            const disabled =
              (k === "district" && districts.length === 0) ||
              (k === "neighborhood" && neighborhoods.length === 0);
            const active = scopeKind === k;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={active}
                onClick={() => !disabled && setScopeKind(k)}
                disabled={disabled}
                title={
                  disabled
                    ? `No ${k} polygons available for this city yet`
                    : undefined
                }
                className="px-3 py-1 rounded-full font-semibold uppercase tracking-wider transition-colors"
                style={{
                  background: active ? "rgba(59,130,246,0.15)" : "transparent",
                  color: disabled
                    ? "var(--panel-text-muted)"
                    : active
                      ? "#3b82f6"
                      : "var(--panel-text-secondary)",
                  opacity: disabled ? 0.5 : 1,
                  cursor: disabled ? "not-allowed" : "pointer",
                }}
              >
                {k}
              </button>
            );
          })}
        </div>

        {scopeKind !== "city" && (
          <div className="relative">
            <select
              aria-label={`Select ${scopeKind}`}
              value={effectiveScopeSlug ?? ""}
              onChange={(e) => setRequestedScopeSlug(e.target.value || null)}
              className="appearance-none pr-7 pl-2.5 py-1 rounded-full text-[11px] font-medium"
              style={{
                background: "var(--panel-input-bg)",
                color: "var(--panel-text)",
                border: "1px solid var(--panel-border)",
              }}
            >
              {(scopeKind === "district" ? districts : neighborhoods).map((x) => (
                <option key={x.slug} value={x.slug}>
                  {x.name}
                </option>
              ))}
            </select>
            <ChevronDown
              className="w-3 h-3 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: "var(--panel-text-muted)" }}
            />
          </div>
        )}

        <div className="flex-1 min-w-2" />

        <div
          className="inline-flex rounded-full p-0.5 text-[11px]"
          style={{ background: "var(--panel-input-bg)", border: "1px solid var(--panel-border)" }}
          role="group"
          aria-label="Time window"
        >
          {TIME_WINDOWS.map((w) => {
            const active = windowHours === w.hours;
            return (
              <button
                key={w.label}
                type="button"
                aria-pressed={active}
                onClick={() => setWindowHours(w.hours)}
                className="px-2.5 py-1 rounded-full font-semibold tracking-wider transition-colors"
                style={{
                  background: active ? "rgba(59,130,246,0.15)" : "transparent",
                  color: active ? "#3b82f6" : "var(--panel-text-secondary)",
                }}
              >
                {w.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        className="px-4 py-2 flex flex-wrap items-center gap-2"
        style={{ borderBottom: "1px solid var(--panel-border)" }}
      >
        <IncidentTypeFilterChips
          activeCats={activeCats}
          onActiveCatsChange={setActiveCats}
          incidentsForCounts={timeWindowed}
        />
      </div>

      {/* ── Sub-tabs ──────────────────────────────────────────────────── */}
      <div
        className="flex items-stretch overflow-x-auto no-scrollbar"
        style={{ borderBottom: "1px solid var(--panel-border)" }}
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          const Icon = t.Icon;
          return (
            <button type="button"
              key={t.id}
              onClick={() => setTab(t.id)}
              className="flex items-center gap-1.5 px-3.5 py-2 text-[11px] font-bold uppercase tracking-wider transition-colors relative shrink-0"
              style={{
                color: active ? "#3b82f6" : "var(--panel-text-secondary)",
                background: active ? "rgba(59,130,246,0.06)" : "transparent",
              }}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
              {active && (
                <span
                  className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full"
                  style={{ background: "#3b82f6" }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div ref={exportTargetRef} className="p-4 space-y-5 max-h-[min(72vh,900px)] overflow-y-auto">
        {totalCount === 0 ? (
          <EmptyState scopeLabel={scopeLabel} categoryOnly={emptyBecauseCategoryOnly} />
        ) : tab === "overview" ? (
          <Overview
            scopeLabel={scopeLabel}
            total={totalCount}
            sevSum={sevSum}
            sevIndex={sevIndex}
            activeNow={activeNow}
            wow={wow}
            mix={mix}
            comparison={comparison}
            hasComparison={comparison !== null}
            windowHours={windowHours}
            mentions={mentions}
          />
        ) : tab === "hotspots" ? (
          <Hotspots
            hotspots={hotspots}
            geoCells={geoCells}
            scopeKind={scopeKind}
            districts={districts}
            neighborhoods={neighborhoods}
            scoped={scoped}
            typeFilterActive={activeCats.size > 0}
            onFocusDistrict={focusDistrict}
            onFocusNeighborhood={focusNeighborhood}
            onFocusPoint={focusPoint}
          />
        ) : tab === "categories" ? (
          <CategoriesTab trends={trends} dayNight={dayNight} />
        ) : tab === "timing" ? (
          <TimingTab grid={grid} calendar={calendar} hours={hours} quietWindow={quietWindow} />
        ) : tab === "routes" ? (
          <RoutesTab
            routeHours={routeHours}
            routeIncidents={routeIncidents}
            hasRoute={Boolean(routeGeometry && routeGeometry.length > 1)}
          />
        ) : (
          <QualityTab
            feeds={feeds}
            feedsWeighted={feedsWeighted}
            quality={quality}
            confTrend={confTrend}
            inhibTrend={inhibTrend}
          />
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Empty state
// ──────────────────────────────────────────────────────────────────────────

function EmptyState({ scopeLabel, categoryOnly }: { scopeLabel: string; categoryOnly?: boolean }) {
  return (
    <div
      className="rounded-lg p-6 text-center"
      style={{ background: "var(--panel-input-bg)", color: "var(--panel-text-muted)" }}
    >
      <BarChart3 className="w-6 h-6 mx-auto mb-2 opacity-50" />
      <p className="text-sm font-medium" style={{ color: "var(--panel-text-secondary)" }}>
        {categoryOnly
          ? "No incidents match the selected types in this scope and window."
          : `No incidents in ${scopeLabel} for this window.`}
      </p>
      <p className="text-[11px] mt-1">
        {categoryOnly ? "Clear type filters or pick another combination." : "Try a wider time range, or switch scope."}
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Overview tab
// ──────────────────────────────────────────────────────────────────────────

interface OverviewProps {
  scopeLabel: string;
  total: number;
  sevSum: number;
  sevIndex: number[];
  activeNow: number;
  wow: ReturnType<typeof categoryWoW>;
  mix: ReturnType<typeof severityBucketMix>;
  comparison: ReturnType<typeof areaVsCityComparison> | null;
  hasComparison: boolean;
  windowHours: number;
  mentions: ReturnType<typeof mentionVelocity>;
}

function Overview({
  scopeLabel,
  total,
  sevSum,
  sevIndex,
  activeNow,
  wow,
  mix,
  comparison,
  hasComparison,
  windowHours,
  mentions,
}: OverviewProps) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Incidents" value={total.toLocaleString()} icon={<BarChart3 className="w-3.5 h-3.5" />} />
        <Stat
          label="Severity index"
          value={Math.round(sevSum * 10) / 10}
          icon={<TrendingUp className="w-3.5 h-3.5" />}
          hint="sum of s_base"
        />
        <Stat
          label="Active right now"
          value={activeNow}
          accent={activeNow > 0 ? "#22c55e" : undefined}
          icon={<Activity className="w-3.5 h-3.5" />}
          hint="live scanner threads"
        />
        <Stat
          label="Heating up"
          value={mentions.heatingCount}
          icon={<Activity className="w-3.5 h-3.5" />}
          hint={`${mentions.recentUpdates} mention updates`}
        />
      </div>

      <Section title="Severity index (last 30d)" icon={<TrendingUp className="w-3.5 h-3.5" />}>
        <div className="flex items-center gap-3">
          <Sparkline data={sevIndex} color="#a855f7" width={240} height={36} filled className="flex-1" />
          <div className="text-right">
            <div className="text-base font-bold" style={{ color: "var(--panel-text)" }}>
              {Math.round(sevSum * 10) / 10}
            </div>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--panel-text-muted)" }}>
              total
            </div>
          </div>
        </div>
        <p className="text-[10px] mt-1.5" style={{ color: "var(--panel-text-muted)" }}>
          Weighted by per-incident base severity, so a quiet day with a serious call still counts.
        </p>
      </Section>

      <Section title="Category mix" icon={<LayersIcon className="w-3.5 h-3.5" />}>
        <div className="flex items-center gap-4">
          <DonutChart
            segments={mix.map((m) => ({ label: m.label, value: m.count, color: m.color }))}
            size={108}
          />
          <div className="flex-1 space-y-1">
            {mix
              .filter((m) => m.count > 0)
              .map((m) => (
                <div key={m.bucket} className="flex items-center gap-2 text-[11px]">
                  <span className="w-2 h-2 rounded-full" style={{ background: m.color }} />
                  <span className="flex-1" style={{ color: "var(--panel-text-secondary)" }}>
                    {m.label}
                  </span>
                  <span className="font-mono" style={{ color: "var(--panel-text-muted)" }}>
                    {m.count}
                  </span>
                  <span className="font-mono w-10 text-right" style={{ color: "var(--panel-text)" }}>
                    {Math.round(m.share * 100)}%
                  </span>
                </div>
              ))}
          </div>
        </div>
      </Section>

      <Section
        title={`What changed (${windowLabel(windowHours)} vs prior)`}
        icon={<TrendingDown className="w-3.5 h-3.5" />}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
          {wow.map((row) => {
            const up = row.pct != null && row.pct > 0;
            const down = row.pct != null && row.pct < 0;
            return (
              <div
                key={row.label}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md"
                style={{ background: "var(--panel-input-bg)" }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: row.color }} />
                <span className="text-[11px] flex-1" style={{ color: "var(--panel-text-secondary)" }}>
                  {row.label}
                </span>
                <span className="text-[11px] font-mono" style={{ color: "var(--panel-text-muted)" }}>
                  {row.current}
                </span>
                {row.pct == null ? (
                  <span className="text-[10px] font-mono w-12 text-right" style={{ color: "var(--panel-text-muted)" }}>
                    new
                  </span>
                ) : (
                  <span
                    className="text-[10px] font-mono w-12 text-right"
                    style={{ color: up ? "#ef4444" : down ? "#22c55e" : "var(--panel-text-muted)" }}
                  >
                    {up ? "+" : ""}
                    {row.pct}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {hasComparison && comparison && (
        <Section
          title={`${scopeLabel} vs city composition`}
          icon={<BarChart3 className="w-3.5 h-3.5" />}
        >
          <div className="space-y-1.5">
            {comparison.map((cat) => {
              const diff = cat.areaRate - cat.cityRate;
              const isAbove = diff > 0.01;
              const isBelow = diff < -0.01;
              const barWidth = Math.min(100, Math.max(5, Math.round(cat.areaRate * 500)));
              return (
                <div key={cat.label} className="flex items-center gap-2">
                  <span className="text-[11px] w-16 shrink-0" style={{ color: "var(--panel-text-secondary)" }}>
                    {cat.label}
                  </span>
                  <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: "var(--panel-input-bg)" }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${barWidth}%`,
                        backgroundColor: isAbove ? "#ef4444" : isBelow ? "#22c55e" : cat.color,
                      }}
                    />
                  </div>
                  <span
                    className="text-[10px] font-mono w-12 text-right"
                    style={{
                      color: isAbove
                        ? "#ef4444"
                        : isBelow
                          ? "#22c55e"
                          : "var(--panel-text-muted)",
                    }}
                  >
                    {isAbove ? "+" : ""}
                    {Math.round(diff * 100)}%
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Hotspots tab
// ──────────────────────────────────────────────────────────────────────────

interface HotspotsProps {
  hotspots: ReturnType<typeof topHotspots>;
  geoCells: ReturnType<typeof geoDensityGrid>;
  scopeKind: ScopeKind;
  districts: District[];
  neighborhoods: Neighborhood[];
  scoped: Incident[];
  typeFilterActive: boolean;
  onFocusDistrict: (slug: string) => void;
  onFocusNeighborhood: (slug: string) => void;
  onFocusPoint: (lat: number, lng: number) => void;
}

function Hotspots({
  hotspots,
  geoCells,
  scopeKind,
  districts,
  neighborhoods,
  scoped,
  typeFilterActive,
  onFocusDistrict,
  onFocusNeighborhood,
  onFocusPoint,
}: HotspotsProps) {
  // District / neighborhood leaderboard for the current slice — only meaningful
  // when the user is looking at the whole city; otherwise we'd just show one row.
  const leaderboard = useMemo(() => {
    if (scopeKind !== "city") return null;
    const list = districts.length > 0 ? districts : neighborhoods;
    if (list.length === 0) return null;
    type Row = { slug: string; name: string; count: number; topCat: string; kind: ScopeKind };
    const isDistrict = districts.length > 0;
    const rows: Row[] = list
      .map((x) => {
        const incs = isDistrict
          ? incidentsInDistrict(scoped, x.slug)
          : incidentsInNeighborhood(scoped, x.slug);
        if (incs.length === 0) return null;
        const cats: Record<string, number> = {};
        for (const i of incs) cats[i.severity_category] = (cats[i.severity_category] ?? 0) + 1;
        const top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
        return {
          slug: x.slug,
          name: x.name,
          count: incs.length,
          topCat: top?.[0] ?? "other",
          kind: isDistrict ? "district" : "neighborhood",
        };
      })
      .filter((r): r is Row => r !== null)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return { rows, kind: isDistrict ? "districts" : "neighborhoods" };
  }, [scopeKind, districts, neighborhoods, scoped]);

  return (
    <div className="space-y-5">
      {leaderboard && leaderboard.rows.length > 0 && (
        <Section
          title={`Top ${leaderboard.kind}`}
          icon={<MapPin className="w-3.5 h-3.5" />}
        >
          <ol className="space-y-1">
            {leaderboard.rows.map((row, i) => {
              const max = leaderboard.rows[0].count;
              const w = Math.max(4, Math.round((row.count / max) * 100));
              return (
                <li key={row.slug}>
                  <button
                    type="button"
                    onClick={() =>
                      row.kind === "district"
                        ? onFocusDistrict(row.slug)
                        : onFocusNeighborhood(row.slug)
                    }
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-white/5 transition-colors"
                  >
                    <span
                      className="text-[10px] font-mono w-5 text-right shrink-0"
                      style={{ color: "var(--panel-text-muted)" }}
                    >
                      {i + 1}
                    </span>
                    <span
                      className="text-[12px] font-medium truncate"
                      style={{ color: "var(--panel-text)", flex: "0 0 38%" }}
                    >
                      {row.name}
                    </span>
                    <div
                      className="flex-1 h-1.5 rounded-full overflow-hidden"
                      style={{ background: "var(--panel-input-bg)" }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${w}%`, background: "#3b82f6" }}
                      />
                    </div>
                    <span
                      className="text-[10px] font-mono w-8 text-right shrink-0"
                      style={{ color: "var(--panel-text-secondary)" }}
                    >
                      {row.count}
                    </span>
                    {!typeFilterActive && (
                    <span
                      className="text-[10px] uppercase tracking-wider w-20 text-right shrink-0 truncate"
                      style={{ color: "var(--panel-text-muted)" }}
                      title={categoryDisplay(row.topCat)}
                    >
                      {categoryDisplay(row.topCat)}
                    </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        </Section>
      )}

      {geoCells.length > 0 && (
        <Section title="Geo density" icon={<Grid3X3 className="w-3.5 h-3.5" />}>
          <div className="space-y-1">
            {geoCells.map((cell) => (
              <button
                key={cell.key}
                type="button"
                onClick={() => onFocusPoint(cell.lat, cell.lng)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-white/5 transition-colors"
              >
                <span className="text-[11px] flex-1 font-mono" style={{ color: "var(--panel-text-secondary)" }}>
                  {cell.lat.toFixed(2)}, {cell.lng.toFixed(2)}
                </span>
                <span className="text-[11px] font-mono" style={{ color: "var(--panel-text)" }}>
                  {cell.count}
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title="Recurring locations" icon={<MapPin className="w-3.5 h-3.5" />}>
        {hotspots.length === 0 ? (
          <p className="text-[11px]" style={{ color: "var(--panel-text-muted)" }}>
            No locations have repeated yet in this window.
          </p>
        ) : (
          <ol className="space-y-1">
            {hotspots.map((h, i) => (
              <li key={h.key}>
                <button
                  type="button"
                  onClick={() => h.lat != null && h.lng != null && onFocusPoint(h.lat, h.lng)}
                  disabled={h.lat == null}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-white/5 transition-colors disabled:cursor-default"
                >
                  <span
                    className="text-[10px] font-mono w-5 text-right shrink-0"
                    style={{ color: "var(--panel-text-muted)" }}
                  >
                    {i + 1}
                  </span>
                  <span
                    className="text-[12px] font-medium truncate flex-1"
                    style={{ color: "var(--panel-text)" }}
                  >
                    {h.label}
                  </span>
                  {!typeFilterActive && (
                  <span
                    className="text-[10px] uppercase tracking-wider truncate w-24 text-right shrink-0"
                    style={{ color: "var(--panel-text-muted)" }}
                    title={categoryDisplay(h.topCategory)}
                  >
                    {categoryDisplay(h.topCategory)}
                  </span>
                  )}
                  <span
                    className="text-[10px] font-mono w-10 text-right shrink-0"
                    style={{ color: "var(--panel-text-secondary)" }}
                  >
                    ×{h.count}
                  </span>
                  <span
                    className="text-[10px] w-16 text-right shrink-0"
                    style={{ color: "var(--panel-text-muted)" }}
                  >
                    {timeAgo(h.lastSeen)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
        <p className="text-[10px] mt-2" style={{ color: "var(--panel-text-muted)" }}>
          Grouped by location text (or coarse coordinates when missing). Click a row to focus the map.
        </p>
      </Section>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Categories tab
// ──────────────────────────────────────────────────────────────────────────

function CategoriesTab({
  trends,
  dayNight,
}: {
  trends: ReturnType<typeof trendByDay>;
  dayNight: ReturnType<typeof dayNightByBucket>;
}) {
  return (
    <div className="space-y-5">
      <Section title="30-day trends by category" icon={<TrendingUp className="w-3.5 h-3.5" />}>
        <div className="space-y-2">
          {trends.map((trend) => {
            const total = trend.data.reduce((s, d) => s + d.count, 0);
            if (total === 0) return null;
            return (
              <div key={trend.label} className="flex items-center gap-3">
                <span
                  className="text-[11px] font-medium w-16 shrink-0"
                  style={{ color: trend.color }}
                >
                  {trend.label}
                </span>
                <Sparkline
                  data={trend.data.map((d) => d.count)}
                  color={trend.color}
                  width={140}
                  height={24}
                  filled
                  className="flex-1"
                />
                <span
                  className="text-[11px] font-mono w-10 text-right"
                  style={{ color: "var(--panel-text-secondary)" }}
                >
                  {total}
                </span>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Day vs night share" icon={<Moon className="w-3.5 h-3.5" />}>
        <div className="space-y-1.5">
          {dayNight.map((row) => {
            const dayShare = 1 - row.nightShare;
            return (
              <div key={row.bucket} className="flex items-center gap-2">
                <span
                  className="text-[11px] w-16 shrink-0"
                  style={{ color: row.color }}
                >
                  {row.label}
                </span>
                <div
                  className="flex-1 h-3 rounded-full overflow-hidden flex"
                  style={{ background: "var(--panel-input-bg)" }}
                >
                  <div
                    className="h-full"
                    title={`Day · ${Math.round(dayShare * 100)}%`}
                    style={{ width: `${dayShare * 100}%`, background: "#fbbf24" }}
                  />
                  <div
                    className="h-full"
                    title={`Night · ${Math.round(row.nightShare * 100)}%`}
                    style={{ width: `${row.nightShare * 100}%`, background: "#6366f1" }}
                  />
                </div>
                <span
                  className="text-[10px] font-mono w-10 text-right"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  {row.total}
                </span>
                <span
                  className="text-[10px] font-mono w-14 text-right flex items-center justify-end gap-1"
                  style={{ color: "var(--panel-text-secondary)" }}
                >
                  <Moon className="w-3 h-3" />
                  {Math.round(row.nightShare * 100)}%
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] mt-2 flex items-center gap-2" style={{ color: "var(--panel-text-muted)" }}>
          <Sun className="w-3 h-3" /> Day = 5am–10pm
          <span className="opacity-60">·</span>
          <Moon className="w-3 h-3" /> Night = 10pm–5am
        </p>
      </Section>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Timing tab
// ──────────────────────────────────────────────────────────────────────────

function TimingTab({
  grid,
  calendar,
  hours,
  quietWindow,
}: {
  grid: number[][];
  calendar: ReturnType<typeof calendarGrid>;
  hours: number[];
  quietWindow: { startHour: number; endHour: number; avgIncidents: number };
}) {
  return (
    <div className="space-y-5">
      <Section title="Daily volume (last 12 weeks)" icon={<Grid3X3 className="w-3.5 h-3.5" />}>
        <div className="overflow-x-auto -mx-1 px-1">
          <CalendarHeatmap cells={calendar} />
        </div>
      </Section>

      <Section title="Day × hour heatmap" icon={<Grid3X3 className="w-3.5 h-3.5" />}>
        <TimeGrid data={grid} width={320} height={120} />
      </Section>

      <Section title="Hour-of-day shape" icon={<Clock className="w-3.5 h-3.5" />}>
        <Sparkline data={hours} color="#3b82f6" width={300} height={40} filled />
        <p className="text-[10px] mt-2" style={{ color: "var(--panel-text-muted)" }}>
          Quietest 2-hour window: <strong style={{ color: "var(--panel-text-secondary)" }}>
            {formatHour(quietWindow.startHour)}–{formatHour(quietWindow.endHour)}
          </strong>{" "}
          (~{quietWindow.avgIncidents.toFixed(1)} incidents/hr).
        </p>
      </Section>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Data quality tab
// ──────────────────────────────────────────────────────────────────────────

function RoutesTab({
  routeHours,
  routeIncidents,
  hasRoute,
}: {
  routeHours: number[] | null;
  routeIncidents: Incident[];
  hasRoute: boolean;
}) {
  if (!hasRoute || !routeHours) {
    return (
      <div className="rounded-lg p-6 text-center" style={{ background: "var(--panel-input-bg)" }}>
        <p className="text-sm" style={{ color: "var(--panel-text-secondary)" }}>
          Plan a route on the map to see corridor safety by hour.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <Section title="Incidents along route" icon={<Activity className="w-3.5 h-3.5" />}>
        {routeIncidents.length === 0 ? (
          <p className="text-[11px]" style={{ color: "var(--panel-text-muted)" }}>No incidents in the route buffer for this window.</p>
        ) : (
          <ol className="space-y-1">
            {routeIncidents.map((inc) => (
              <li key={inc.id} className="text-[11px] truncate" style={{ color: "var(--panel-text-secondary)" }}>
                {categoryDisplay(inc.severity_category)} · {inc.location_text || "Unknown location"}
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section title="Hour-of-day along corridor" icon={<Clock className="w-3.5 h-3.5" />}>
        <Sparkline data={routeHours} color="#f59e0b" width={300} height={40} filled />
      </Section>
    </div>
  );
}

function QualityTab({
  feeds,
  feedsWeighted,
  quality,
  confTrend,
  inhibTrend,
}: {
  feeds: ReturnType<typeof feedMix>;
  feedsWeighted: ReturnType<typeof feedMixWeighted>;
  quality: ReturnType<typeof dataQuality>;
  confTrend: ReturnType<typeof confidenceTrend>;
  inhibTrend: ReturnType<typeof inhibitorTrend>;
}) {
  return (
    <div className="space-y-5">
      <Section title="Pipeline health" icon={<Database className="w-3.5 h-3.5" />}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Stat
            label="Geocoded"
            value={`${Math.round(quality.geocodedShare * 100)}%`}
            hint={`${quality.geocoded} / ${quality.total}`}
          />
          <Stat
            label="Avg mentions"
            value={quality.meanMentionCount.toFixed(2)}
            hint={`${quality.withMentions} threaded`}
          />
          <Stat
            label="Median confidence"
            value={quality.medianConfidence.toFixed(2)}
            hint="LLM extraction"
          />
          <Stat
            label="Total"
            value={quality.total.toLocaleString()}
            hint="in scope + window"
          />
        </div>

        {quality.inhibitorBreakdown.length > 0 && (
          <div className="mt-3 space-y-1">
            <div
              className="text-[10px] font-bold uppercase tracking-wider"
              style={{ color: "var(--panel-text-muted)" }}
            >
              Inhibitor status
            </div>
            {quality.inhibitorBreakdown.map((row) => (
              <div key={row.status} className="flex items-center gap-2">
                <span
                  className="text-[11px] flex-1"
                  style={{ color: "var(--panel-text-secondary)" }}
                >
                  {row.status}
                </span>
                <div
                  className="w-32 h-1.5 rounded-full overflow-hidden"
                  style={{ background: "var(--panel-input-bg)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${row.share * 100}%`,
                      background: row.status === "passed" ? "#22c55e" : "#94a3b8",
                    }}
                  />
                </div>
                <span
                  className="text-[10px] font-mono w-10 text-right"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  {Math.round(row.share * 100)}%
                </span>
                <span
                  className="text-[10px] font-mono w-10 text-right"
                  style={{ color: "var(--panel-text-secondary)" }}
                >
                  {row.count}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Scanner feed contribution" icon={<Radio className="w-3.5 h-3.5" />}>
        {feeds.length === 0 ? (
          <p className="text-[11px]" style={{ color: "var(--panel-text-muted)" }}>
            No feed_id metadata in this slice.
          </p>
        ) : (
          <div className="space-y-1">
            {feeds.slice(0, 8).map((f) => (
              <div key={f.feedId} className="flex items-center gap-2">
                <span
                  className="text-[11px] flex-1 truncate"
                  style={{ color: "var(--panel-text-secondary)" }}
                  title={f.feedId}
                >
                  {f.label}
                </span>
                <div
                  className="w-32 h-1.5 rounded-full overflow-hidden"
                  style={{ background: "var(--panel-input-bg)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${f.share * 100}%`, background: "#3b82f6" }}
                  />
                </div>
                <span
                  className="text-[10px] font-mono w-10 text-right"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  {Math.round(f.share * 100)}%
                </span>
                <span
                  className="text-[10px] font-mono w-10 text-right"
                  style={{ color: "var(--panel-text-secondary)" }}
                >
                  {f.count}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Confidence trend (14d)" icon={<TrendingUp className="w-3.5 h-3.5" />}>
        <Sparkline data={confTrend.map((p) => p.confidence)} color="#22c55e" width={300} height={40} filled />
      </Section>

      {inhibTrend.length > 0 && (
        <Section title="Inhibitor reasons (14d)" icon={<Database className="w-3.5 h-3.5" />}>
          <div className="space-y-1">
            {inhibTrend.slice(0, 6).map((row) => (
              <div key={row.reason} className="flex items-center justify-between text-[11px]">
                <span style={{ color: "var(--panel-text-secondary)" }}>{row.reason}</span>
                <span className="font-mono" style={{ color: "var(--panel-text)" }}>{row.count}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {feedsWeighted.length > 0 && (
        <Section title="Severity-weighted feeds" icon={<Radio className="w-3.5 h-3.5" />}>
          <div className="space-y-1">
            {feedsWeighted.slice(0, 6).map((f) => (
              <div key={f.feedId} className="flex items-center gap-2 text-[11px]">
                <span className="flex-1 truncate" style={{ color: "var(--panel-text-secondary)" }}>{f.label}</span>
                <span className="font-mono" style={{ color: "var(--panel-text)" }}>{Math.round(f.share * 100)}%</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4
        className="text-[11px] font-bold uppercase tracking-wider mb-2.5 flex items-center gap-1.5"
        style={{ color: "var(--panel-text-muted)" }}
      >
        {icon}
        {title}
      </h4>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  icon,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  accent?: string;
}) {
  return (
    <div
      className="rounded-lg p-2.5"
      style={{ background: "var(--panel-input-bg)", border: "1px solid var(--panel-border)" }}
    >
      <div
        className="text-[10px] uppercase tracking-wider flex items-center gap-1"
        style={{ color: "var(--panel-text-muted)" }}
      >
        {icon}
        {label}
      </div>
      <div
        className="text-lg font-bold mt-0.5"
        style={{ color: accent ?? "var(--panel-text)" }}
      >
        {value}
      </div>
      {hint && (
        <div className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function formatHour(h: number): string {
  if (h === 0) return "12a";
  if (h === 12) return "12p";
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

function windowLabel(hours: number): string {
  if (!Number.isFinite(hours)) return "all time";
  if (hours <= 24) return "24h";
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const m = Math.round(diffSec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}
