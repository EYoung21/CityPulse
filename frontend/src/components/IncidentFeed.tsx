"use client";

import { useState, useMemo, useEffect } from "react";
import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";
import { incidentHeadline, incidentLocationLabel } from "@/lib/incident-display";
import IncidentThumbnail from "./IncidentThumbnail";
import IncidentDetail from "./IncidentDetail";
import FeedIncidentSkeleton from "./FeedIncidentSkeleton";
import { useIsMobile } from "@/hooks/useIsMobile";
import { haptic } from "@/lib/native";
import { getRandomCityPulseTip } from "@/lib/citypulse-tips";
import { toggleFeedAudio, subscribeFeedAudio, getFeedAudioState } from "./FeedAudioMiniPlayer";
import { Drawer } from "vaul";
import {
  AlertTriangle,
  Flame,
  Car,
  HeartPulse,
  ShieldAlert,
  Volume2,
  CircleDot,
  MapPin,
  ChevronDown,
  Play,
  Pause,
  Map,
} from "lucide-react";
import { resolveBlipKind, monoGlyphSvg } from "./IncidentMap";
import { sanitizeScannerTranscriptForDisplay } from "@/lib/sanitize-scanner-transcript";

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  violent_weapon: <ShieldAlert className="w-4 h-4" />,
  violent_no_weapon: <ShieldAlert className="w-4 h-4" />,
  shots_heard: <Volume2 className="w-4 h-4" />,
  robbery: <AlertTriangle className="w-4 h-4" />,
  burglary_in_progress: <AlertTriangle className="w-4 h-4" />,
  medical_priority: <HeartPulse className="w-4 h-4" />,
  medical_other: <HeartPulse className="w-4 h-4" />,
  fire_hazmat: <Flame className="w-4 h-4" />,
  traffic_crash_injury: <Car className="w-4 h-4" />,
  traffic_crash_no_injury: <Car className="w-4 h-4" />,
  disorder: <CircleDot className="w-4 h-4" />,
};

interface TimeBlock {
  label: string;
  incidents: Incident[];
}

function groupByTimeBlocks(incidents: Incident[]): TimeBlock[] {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const threeHoursAgo = now - 3 * 60 * 60 * 1000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const weekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);

  const blocks: TimeBlock[] = [
    { label: "Last Hour", incidents: [] },
    { label: "Last 3 Hours", incidents: [] },
    { label: "Today", incidents: [] },
    { label: "Yesterday", incidents: [] },
    { label: "This Week", incidents: [] },
    { label: "Older", incidents: [] },
  ];

  for (const inc of incidents) {
    const t = new Date(inc.reported_at).getTime();
    if (t >= hourAgo) blocks[0].incidents.push(inc);
    else if (t >= threeHoursAgo) blocks[1].incidents.push(inc);
    else if (t >= todayStart.getTime()) blocks[2].incidents.push(inc);
    else if (t >= yesterdayStart.getTime()) blocks[3].incidents.push(inc);
    else if (t >= weekStart.getTime()) blocks[4].incidents.push(inc);
    else blocks[5].incidents.push(inc);
  }

  for (const block of blocks) {
    block.incidents.sort((a, b) => {
      const ta = new Date(a.reported_at).getTime();
      const tb = new Date(b.reported_at).getTime();
      return tb - ta;
    });
  }

  return blocks.filter((b) => b.incidents.length > 0);
}

interface Props {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onViewOnMap?: (id: string) => void;
  showMapThumbnail?: boolean;
  sortMode?: "recent" | "near";
  userLoc?: { lat: number; lng: number } | null;
  density?: "compact" | "immersive";
  loading?: boolean;
  newIncidentIds?: Set<string>;
}

function haversineMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function IncidentCard({
  inc,
  isSelected,
  onSelect,
  onViewOnMap,
  showMapThumbnail,
  density = "compact",
  userLoc,
  isNew,
  showInlineDetail = true,
}: {
  inc: Incident;
  isSelected: boolean;
  onSelect: () => void;
  onViewOnMap?: (id: string) => void;
  showMapThumbnail?: boolean;
  density?: "compact" | "immersive";
  userLoc?: { lat: number; lng: number } | null;
  isNew?: boolean;
  showInlineDetail?: boolean;
}) {
  const sev = getSeverity(inc.severity_category);
  const isHighSev = inc.s_base >= 0.7;
  const confidencePct = Math.round(inc.confidence * 100);
  // Reflect the real shared-audio state so the button distinguishes play vs.
  // pause (and resets when the clip ends or another incident takes over).
  const [audioSnap, setAudioSnap] = useState(getFeedAudioState);
  useEffect(() => subscribeFeedAudio(() => setAudioSnap({ ...getFeedAudioState() })), []);
  const playing = audioSnap.incidentId === inc.id && audioSnap.playing;
  const immersive = density === "immersive";
  const headline = incidentHeadline(inc);
  const locationLabel = incidentLocationLabel(inc);
  const canViewOnMap = inc.lat != null && inc.lng != null && !!onViewOnMap;
  const distanceMi =
    userLoc && inc.lat != null && inc.lng != null
      ? haversineMi(userLoc.lat, userLoc.lng, inc.lat, inc.lng)
      : null;

  const confColor =
    confidencePct >= 70 ? "#22c55e" : confidencePct >= 40 ? "#f59e0b" : "#ef4444";

  const openOnMap = (event: React.MouseEvent) => {
    event.stopPropagation();
    void haptic("light");
    if (canViewOnMap) onViewOnMap?.(inc.id);
  };

  const toggleAudio = (e: React.MouseEvent) => {
    e.stopPropagation();
    void haptic("light");
    toggleFeedAudio(inc, headline);
  };

  const supportingText =
    inc.description?.trim() && inc.raw_text?.trim() && inc.raw_text.trim() !== inc.description.trim()
      ? sanitizeScannerTranscriptForDisplay(inc.raw_text.trim())
      : null;

  const baseOpacity = confidencePct < 40 ? 0.6 : 1;

  return (
    <div
      className={`group relative text-left transition-all duration-200 ${
        immersive ? "rounded-2xl mx-2 my-1.5 border border-white/5" : "rounded-lg"
      } ${isSelected ? "bg-white/10 ring-1 ring-white/10" : "hover:bg-white/5"} ${
        isNew ? "feed-incident-new" : ""
      }`}
      style={{ opacity: baseOpacity }}
    >
      <div
        onClick={() => {
          void haptic("selection");
          onSelect();
        }}
        className={`flex items-start gap-2.5 cursor-pointer ${immersive ? "px-4 py-3.5" : "px-3 py-2.5"}`}
        role="button"
        tabIndex={0}
        aria-expanded={isSelected}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void haptic("selection");
            onSelect();
          }
        }}
      >
        <div
          className={`absolute left-0 w-[3px] rounded-full transition-opacity ${
            immersive ? "top-0 bottom-0" : "top-2 bottom-2"
          }`}
          style={{ backgroundColor: sev.markerColor, opacity: isSelected ? 1 : 0.4 }}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span
              className={`font-bold uppercase tracking-wider ${immersive ? "text-xs" : "text-[11px]"}`}
              style={{ color: sev.markerColor }}
            >
              {sev.label}
            </span>
            {isNew && (
              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                New
              </span>
            )}
            {isHighSev && <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />}
          </div>

          <p
            className={`font-semibold leading-snug ${immersive ? "text-base" : "text-sm"} ${
              isSelected ? "" : "line-clamp-2"
            }`}
            style={{ color: "var(--panel-text, rgba(255,255,255,0.92))" }}
          >
            {headline}
          </p>

          <div
            className="mt-1 flex items-center gap-1.5 text-xs truncate"
            style={{ color: "var(--panel-text-secondary, rgba(255,255,255,0.5))" }}
          >
            <MapPin className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted, rgba(255,255,255,0.3))" }} />
            <span className="truncate">{locationLabel}</span>
            {distanceMi != null && (
              <span className="shrink-0 font-mono text-[10px]" style={{ color: "#60a5fa" }}>
                {distanceMi < 0.1 ? "<0.1" : distanceMi.toFixed(1)} mi
              </span>
            )}
          </div>

          {supportingText && !isSelected && (
            <p
              className="mt-1 text-xs leading-snug italic line-clamp-2"
              style={{ color: "var(--panel-text-secondary, rgba(255,255,255,0.5))" }}
            >
              &ldquo;{supportingText}&rdquo;
            </p>
          )}

          <div className="mt-1.5 flex items-center gap-2">
            {(inc.audio_url || inc.audio_clip) && !(isSelected && showInlineDetail) && (
              <button
                onClick={toggleAudio}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium transition-all ${
                  playing ? "bg-blue-500 text-white" : "bg-blue-500/15 text-blue-400 hover:bg-blue-500/25"
                }`}
              >
                {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                {playing ? "Playing" : "Listen"}
              </button>
            )}

            {inc.lat != null && inc.lng != null && !showMapThumbnail && (
              <button
                type="button"
                onClick={openOnMap}
                disabled={!canViewOnMap}
                className="w-12 h-8 rounded border overflow-hidden shrink-0 disabled:opacity-60"
                style={{ borderColor: "var(--panel-border, rgba(255,255,255,0.1))" }}
                title={canViewOnMap ? "View on map" : undefined}
                aria-label={canViewOnMap ? "View on map" : undefined}
              >
                <div className="w-full h-full relative" style={{ background: "var(--panel-input-bg, rgba(255,255,255,0.05))" }}>
                  <div
                    className="absolute w-1.5 h-1.5 rounded-full"
                    style={{
                      backgroundColor: sev.markerColor,
                      top: "50%",
                      left: "50%",
                      transform: "translate(-50%, -50%)",
                      boxShadow: `0 0 4px ${sev.markerColor}`,
                    }}
                  />
                </div>
              </button>
            )}

            <div className="h-1 flex-1 rounded-full overflow-hidden" style={{ background: "var(--panel-input-bg, rgba(255,255,255,0.05))" }}>
              <div className="h-full rounded-full" style={{ width: `${confidencePct}%`, backgroundColor: confColor }} />
            </div>
            <span className="text-[10px] font-mono shrink-0" style={{ color: confColor }}>
              {confidencePct}%
            </span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-start gap-1.5">
            {showMapThumbnail && inc.lat != null && inc.lng != null && (
              <IncidentThumbnail
                lat={inc.lat}
                lng={inc.lng}
                width={immersive ? 128 : 110}
                height={immersive ? 84 : 72}
                svgGlyph={monoGlyphSvg(resolveBlipKind(inc), inc.id)}
                onClick={canViewOnMap ? openOnMap : undefined}
                title={canViewOnMap ? "View on map" : undefined}
              />
            )}
            <div
              className="mt-0.5 w-8 h-8 rounded-md flex items-center justify-center shrink-0"
              style={{
                background: "var(--panel-input-bg, rgba(255,255,255,0.06))",
                color: "var(--panel-text-secondary, rgba(255,255,255,0.55))",
              }}
              title={sev.label}
              aria-label={`Type: ${sev.label}`}
            >
              {CATEGORY_ICONS[inc.severity_category] || <CircleDot className="w-4 h-4" />}
            </div>
          </div>
          <span className="text-[11px] font-mono" style={{ color: "var(--panel-text-muted, rgba(255,255,255,0.3))" }}>
            {timeAgo(inc.reported_at)}
          </span>
          {showInlineDetail && (
            <ChevronDown
              className={`w-4 h-4 transition-transform ${isSelected ? "rotate-180" : ""}`}
              style={{ color: isSelected ? "#60a5fa" : "var(--panel-text-muted, rgba(255,255,255,0.35))" }}
              aria-hidden
            />
          )}
          {(inc.mention_count ?? 0) > 1 && inc.last_mention_at && (
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: "rgba(59,130,246,0.15)", color: "#60a5fa" }}
              title={`${inc.mention_count} scanner mentions`}
            >
              +{(inc.mention_count ?? 1) - 1} upd · {timeAgo(inc.last_mention_at)}
            </span>
          )}
        </div>
      </div>

      {isSelected && showInlineDetail && (
        <div className="px-3 pb-3 space-y-2" onClick={(event) => event.stopPropagation()}>
          {canViewOnMap && (
            <button
              type="button"
              onClick={openOnMap}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors hover:bg-blue-500/25"
              style={{ background: "rgba(59,130,246,0.15)", color: "#60a5fa" }}
            >
              <Map className="w-3.5 h-3.5" />
              View on map
            </button>
          )}
          <IncidentDetail incident={inc} onClose={onSelect} inFeed />
        </div>
      )}
    </div>
  );
}

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export default function IncidentFeed({
  incidents,
  selectedId,
  onSelect,
  onViewOnMap,
  showMapThumbnail,
  sortMode = "recent",
  userLoc,
  density = "compact",
  loading = false,
  newIncidentIds,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isMobile = useIsMobile();
  const immersive = density === "immersive";
  const selected = incidents.find((i) => i.id === selectedId) ?? null;
  const emptyTip = useMemo(() => getRandomCityPulseTip(), []);

  const blocks = useMemo(() => {
    if (sortMode === "near" && userLoc) {
      const distSq = (lat1: number, lng1: number, lat2: number, lng2: number) => {
        return (lat1 - lat2) ** 2 + (lng1 - lng2) ** 2;
      };
      const sorted = [...incidents].filter((i) => i.lat != null && i.lng != null).sort((a, b) => {
        return distSq(a.lat!, a.lng!, userLoc.lat, userLoc.lng) - distSq(b.lat!, b.lng!, userLoc.lat, userLoc.lng);
      });
      return [{ label: "Nearest to You", incidents: sorted }];
    }
    return groupByTimeBlocks(incidents);
  }, [incidents, sortMode, userLoc]);

  if (loading && incidents.length === 0) {
    return (
      <div>
        <FeedIncidentSkeleton immersive={immersive} />
        <p className="px-4 pb-4 text-center text-[11px] leading-relaxed" style={{ color: "var(--panel-text-muted)" }}>
          {emptyTip}
        </p>
      </div>
    );
  }

  if (incidents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "var(--panel-input-bg, rgba(255,255,255,0.05))" }}>
          <RadioIcon className="w-5 h-5" style={{ color: "var(--panel-text-muted, rgba(255,255,255,0.3))" }} />
        </div>
        <p className="text-sm font-mono" style={{ color: "var(--panel-text-muted, rgba(255,255,255,0.3))" }}>AWAITING INCIDENTS</p>
        <p className="max-w-xs px-6 text-center text-[11px] leading-relaxed" style={{ color: "var(--panel-text-muted, rgba(255,255,255,0.3))" }}>
          {emptyTip}
        </p>
      </div>
    );
  }

  const renderCard = (inc: Incident) => (
    <IncidentCard
      key={inc.id}
      inc={inc}
      isSelected={inc.id === selectedId}
      onSelect={() => onSelect(inc.id)}
      onViewOnMap={onViewOnMap}
      showMapThumbnail={showMapThumbnail}
      density={density}
      userLoc={userLoc}
      isNew={newIncidentIds?.has(inc.id)}
      showInlineDetail={!immersive || !isMobile}
    />
  );

  return (
    <>
      <div className="flex flex-col gap-0.5">
        {blocks.map((block) => {
          const isCollapsed = immersive ? false : (collapsed[block.label] ?? false);
          return (
            <div key={block.label}>
              {immersive ? (
                <div
                  className="sticky top-0 z-10 px-4 py-2 flex items-center gap-2 backdrop-blur-md"
                  style={{ background: "color-mix(in srgb, var(--panel-bg) 88%, transparent)" }}
                >
                  <span className="text-[11px] font-bold uppercase tracking-wider flex-1" style={{ color: "var(--panel-text-secondary)" }}>
                    {block.label}
                  </span>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded-full" style={{ background: "var(--panel-input-bg)" }}>
                    {block.incidents.length}
                  </span>
                </div>
              ) : (
                <button
                  onClick={() => setCollapsed((prev) => ({ ...prev, [block.label]: !isCollapsed }))}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                  style={{ color: "var(--panel-text-secondary, rgba(255,255,255,0.6))" }}
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                  <span className="text-[11px] font-bold uppercase tracking-wider flex-1">{block.label}</span>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded-full" style={{ background: "var(--panel-input-bg, rgba(255,255,255,0.05))" }}>
                    {block.incidents.length}
                  </span>
                </button>
              )}
              {!isCollapsed && block.incidents.map(renderCard)}
            </div>
          );
        })}
        {loading && <FeedIncidentSkeleton count={2} immersive={immersive} />}
      </div>

      {selected && immersive && isMobile && (
        <Drawer.Root open onOpenChange={(open) => { if (!open) onSelect(selected.id); }}>
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 z-[3000] bg-black/40" />
            <Drawer.Content
              className="fixed left-0 right-0 bottom-0 z-[3001] rounded-t-2xl p-4 max-h-[85dvh] overflow-y-auto"
              style={{ background: "var(--panel-bg)", borderTop: "1px solid var(--panel-border)" }}
            >
              <Drawer.Title className="sr-only">Incident details</Drawer.Title>
              <IncidentDetail incident={selected} onClose={() => onSelect(selected.id)} />
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      )}
    </>
  );
}

function RadioIcon(props: React.SVGProps<SVGSVGElement> & { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" /><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4" /><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4" /><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" /><circle cx="12" cy="12" r="2" />
    </svg>
  );
}
