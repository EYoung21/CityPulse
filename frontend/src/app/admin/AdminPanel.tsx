"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Radio,
  FileText,
  Brain,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  MapPin,
  Shield,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import {
  useAdminStream,
  type PipelineGroup,
  type FeedInfo,
} from "@/hooks/useAdminStream";
import AuthBar from "@/components/AuthBar";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

interface Props {
  onBack: () => void;
}

// ── Audio Feed Card ─────────────────────────────────────────────────

function AudioFeedCard({
  feed,
  activeFeedIds,
}: {
  feed: FeedInfo;
  activeFeedIds: Set<string>;
}) {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isActive = activeFeedIds.has(feed.feed_id);

  const toggle = () => {
    if (!audioRef.current) {
      const a = new Audio(`${API_BASE}/api/admin/stream/${feed.feed_id}`);
      a.addEventListener("ended", () => setPlaying(false));
      a.addEventListener("error", () => setPlaying(false));
      audioRef.current = a;
    }
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  };

  const toggleMute = () => {
    if (audioRef.current) audioRef.current.muted = !muted;
    setMuted(!muted);
  };

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all"
      style={{
        background: playing
          ? "rgba(59,130,246,0.08)"
          : "var(--panel-input-bg, rgba(255,255,255,0.04))",
        border: `1px solid ${
          playing
            ? "rgba(59,130,246,0.2)"
            : "var(--panel-border, rgba(255,255,255,0.06))"
        }`,
      }}
    >
      <div className="relative">
        <div
          className={`w-2.5 h-2.5 rounded-full ${
            isActive ? "bg-green-500 animate-pulse" : "bg-gray-600"
          }`}
        />
      </div>

      <div className="flex-1 min-w-0">
        <p
          className="text-xs font-medium truncate"
          style={{ color: "var(--panel-text, #e5e7eb)" }}
        >
          {feed.label}
        </p>
        <p
          className="text-[10px]"
          style={{ color: "var(--panel-text-muted, #6b7280)" }}
        >
          Feed {feed.feed_id}
        </p>
      </div>

      <button
        onClick={toggleMute}
        className="p-1 rounded opacity-50 hover:opacity-100 transition-opacity"
        style={{ color: "var(--panel-text-muted)" }}
      >
        {muted ? (
          <VolumeX className="w-3.5 h-3.5" />
        ) : (
          <Volume2 className="w-3.5 h-3.5" />
        )}
      </button>

      <button
        onClick={toggle}
        className={`p-1.5 rounded-full transition-all ${
          playing
            ? "bg-blue-500 text-white"
            : "bg-white/5 hover:bg-white/10"
        }`}
        style={!playing ? { color: "var(--panel-text-secondary)" } : {}}
      >
        {playing ? (
          <Pause className="w-3.5 h-3.5" />
        ) : (
          <Play className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}

// ── Transcript Entry ────────────────────────────────────────────────

const FEED_COLORS: Record<string, string> = {
  "4603": "#3b82f6",
  "17310": "#8b5cf6",
  "21297": "#06b6d4",
  "45495": "#f97316",
  "18836": "#22c55e",
  "15102": "#ef4444",
  "15195": "#ec4899",
  "34250": "#eab308",
  "15747": "#f43f5e",
  "44308": "#14b8a6",
};

function feedColor(id: string) {
  return FEED_COLORS[id] || "#6b7280";
}

function TranscriptEntry({
  group,
  feedLabel,
}: {
  group: PipelineGroup;
  feedLabel: string;
}) {
  const text = (group.transcript?.text as string) || "";
  const ts = group.transcript?.timestamp as string | undefined;
  const color = feedColor(group.feed_id);

  return (
    <div
      className="px-3 py-2.5 transition-colors"
      style={{ borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.06))" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-[10px] font-semibold" style={{ color }}>
          {feedLabel}
        </span>
        {ts && (
          <span
            className="text-[10px] ml-auto"
            style={{ color: "var(--panel-text-muted)" }}
          >
            {ts}
          </span>
        )}
      </div>
      <p className="text-xs leading-relaxed" style={{ color: "var(--panel-text, #e5e7eb)" }}>
        {text}
      </p>
    </div>
  );
}

// ── Pipeline Card ───────────────────────────────────────────────────

function confidenceColor(c: number): string {
  if (c >= 0.7) return "#22c55e";
  if (c >= 0.4) return "#eab308";
  return "#ef4444";
}

function PipelineCard({
  group,
  feedLabel,
}: {
  group: PipelineGroup;
  feedLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const llm = group.llm_result;
  const inh = group.inhibitor_result;
  const geo = group.geocode_result;
  const stored = group.incident_stored;
  const isRelevant = llm?.is_relevant as boolean | undefined;
  const confidence = (llm?.confidence as number) ?? 0;
  const category = (llm?.category as string) || "";
  const locationText = (llm?.location_text as string) || "";
  const text = (group.transcript?.text as string) || "";

  let outcomeLabel = "Processing...";
  let outcomeColor = "var(--panel-text-muted)";
  let OutcomeIcon = Loader2;

  if (stored) {
    const outcome = stored.outcome as string;
    if (outcome === "created") {
      outcomeLabel = "Stored";
      outcomeColor = "#22c55e";
      OutcomeIcon = CheckCircle2;
    } else if (outcome === "blocked") {
      outcomeLabel = "Blocked";
      outcomeColor = "#ef4444";
      OutcomeIcon = XCircle;
    }
  } else if (llm && isRelevant === false) {
    outcomeLabel = "Rejected";
    outcomeColor = "#6b7280";
    OutcomeIcon = XCircle;
  } else if (group.llm_error) {
    outcomeLabel = "LLM Error";
    outcomeColor = "#ef4444";
    OutcomeIcon = AlertTriangle;
  }

  return (
    <div
      className="rounded-lg overflow-hidden transition-all"
      style={{
        background: "var(--panel-input-bg, rgba(255,255,255,0.04))",
        border: "1px solid var(--panel-border, rgba(255,255,255,0.06))",
      }}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:brightness-110"
      >
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: feedColor(group.feed_id) }}
        />
        <span
          className="text-[10px] font-semibold shrink-0"
          style={{ color: feedColor(group.feed_id) }}
        >
          {feedLabel}
        </span>
        <span
          className="text-xs truncate flex-1"
          style={{ color: "var(--panel-text, #e5e7eb)" }}
        >
          {text.slice(0, 60)}
          {text.length > 60 ? "..." : ""}
        </span>
        <OutcomeIcon
          className={`w-3.5 h-3.5 shrink-0 ${outcomeLabel === "Processing..." ? "animate-spin" : ""}`}
          style={{ color: outcomeColor }}
        />
        {expanded ? (
          <ChevronDown className="w-3 h-3 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2" style={{ borderTop: "1px solid var(--panel-border)" }}>
          {/* Transcript */}
          <div className="pt-2">
            <p className="text-[10px] font-semibold uppercase mb-1" style={{ color: "var(--panel-text-muted)" }}>
              Transcript
            </p>
            <p className="text-xs leading-relaxed" style={{ color: "var(--panel-text-secondary, #9ca3af)" }}>
              {text}
            </p>
          </div>

          {/* LLM Result */}
          {llm && (
            <div
              className="rounded-lg p-2.5"
              style={{ background: "rgba(0,0,0,0.2)" }}
            >
              <div className="flex items-center gap-2 mb-2">
                <Brain className="w-3.5 h-3.5 text-purple-400" />
                <span className="text-[10px] font-semibold text-purple-400 uppercase">
                  LLM Decision
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <span style={{ color: "var(--panel-text-muted)" }}>Relevant: </span>
                  <span style={{ color: isRelevant ? "#22c55e" : "#6b7280" }}>
                    {isRelevant ? "Yes" : "No"}
                  </span>
                </div>
                {isRelevant && (
                  <>
                    <div>
                      <span style={{ color: "var(--panel-text-muted)" }}>Category: </span>
                      <span style={{ color: "var(--panel-text)" }}>
                        {category.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="col-span-2">
                      <span style={{ color: "var(--panel-text-muted)" }}>Confidence: </span>
                      <span style={{ color: confidenceColor(confidence) }}>
                        {(confidence * 100).toFixed(0)}%
                      </span>
                      <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${confidence * 100}%`,
                            background: confidenceColor(confidence),
                          }}
                        />
                      </div>
                    </div>
                    {locationText && (
                      <div className="col-span-2">
                        <span style={{ color: "var(--panel-text-muted)" }}>Location: </span>
                        <span style={{ color: "var(--panel-text)" }}>{locationText}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {group.llm_error && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 rounded-lg px-2.5 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {String(group.llm_error.error)}
            </div>
          )}

          {/* Inhibitor */}
          {inh && (
            <div className="flex items-center gap-2 text-[11px]">
              <Shield className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
              <span style={{ color: "var(--panel-text-muted)" }}>Inhibitor:</span>
              <span
                style={{
                  color:
                    inh.status === "passed"
                      ? "#22c55e"
                      : inh.status === "blocked"
                        ? "#ef4444"
                        : "#eab308",
                }}
              >
                {String(inh.status)}
              </span>
              {inh.reason ? (
                <span className="truncate" style={{ color: "var(--panel-text-muted)" }}>
                  — {String(inh.reason)}
                </span>
              ) : null}
            </div>
          )}

          {/* Geocode */}
          {geo && (
            <div className="flex items-center gap-2 text-[11px]">
              <MapPin className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
              <span style={{ color: "var(--panel-text-muted)" }}>Geocode:</span>
              <span
                style={{
                  color:
                    geo.method === "success"
                      ? "#22c55e"
                      : geo.method === "llm_fallback"
                        ? "#eab308"
                        : "#6b7280",
                }}
              >
                {String(geo.method)}
              </span>
              {geo.lat != null && (
                <span style={{ color: "var(--panel-text-muted)" }}>
                  ({Number(geo.lat).toFixed(4)}, {Number(geo.lng).toFixed(4)})
                </span>
              )}
            </div>
          )}

          {/* Final outcome */}
          {stored && (
            <div className="flex items-center gap-2 text-[11px]">
              <OutcomeIcon className="w-3.5 h-3.5 shrink-0" style={{ color: outcomeColor }} />
              <span style={{ color: outcomeColor }} className="font-medium">
                {outcomeLabel}
              </span>
              <span style={{ color: "var(--panel-text-muted)" }}>
                ID: {String(stored.incident_id).slice(0, 8)}...
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Admin Panel ────────────────────────────────────────────────

export default function AdminPanel({ onBack }: Props) {
  const { events, connected, feeds, pipelineGroups } = useAdminStream();
  const [feedFilter, setFeedFilter] = useState<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const feedMap = new Map(feeds.map((f) => [f.feed_id, f.label]));
  const activeFeedIds = new Set(
    events
      .filter((e) => e.type === "transcript_received")
      .slice(-50)
      .map((e) => e.feed_id)
  );

  const filtered = feedFilter
    ? pipelineGroups.filter((g) => g.feed_id === feedFilter)
    : pipelineGroups;

  const transcriptGroups = filtered
    .filter((g) => g.transcript)
    .slice(-100);

  const pipelineCards = filtered.slice(-80).reverse();

  useEffect(() => {
    if (autoScroll && transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcriptGroups.length, autoScroll]);

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: "var(--map-bg, #0a0a14)" }}
    >
      {/* Top bar */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 shrink-0"
        style={{
          background: "var(--panel-bg, rgba(15,15,25,0.95))",
          borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.08))",
        }}
      >
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: "var(--panel-text-secondary)" }}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        <Shield className="w-5 h-5 text-purple-400" />
        <span
          className="text-sm font-semibold"
          style={{ color: "var(--panel-text)" }}
        >
          Admin Panel
        </span>

        <div className="flex items-center gap-1.5 ml-3">
          {connected ? (
            <Wifi className="w-3.5 h-3.5 text-green-500" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 text-red-500" />
          )}
          <span
            className={`text-[10px] font-medium ${
              connected ? "text-green-500" : "text-red-500"
            }`}
          >
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>

        {/* Feed filter */}
        <select
          value={feedFilter || ""}
          onChange={(e) => setFeedFilter(e.target.value || null)}
          className="ml-auto text-xs rounded-lg px-2.5 py-1.5 outline-none"
          style={{
            background: "var(--panel-input-bg)",
            border: "1px solid var(--panel-border)",
            color: "var(--panel-text)",
          }}
        >
          <option value="">All Feeds</option>
          {feeds.map((f) => (
            <option key={f.feed_id} value={f.feed_id}>
              {f.label}
            </option>
          ))}
        </select>

        <div className="ml-2">
          <AuthBar />
        </div>
      </div>

      {/* Three-column layout */}
      <div className="flex-1 grid grid-cols-[280px_1fr_1fr] gap-0 overflow-hidden">
        {/* LEFT: Audio feeds */}
        <div
          className="flex flex-col overflow-hidden"
          style={{
            background: "var(--panel-bg, rgba(15,15,25,0.95))",
            borderRight: "1px solid var(--panel-border)",
          }}
        >
          <div
            className="flex items-center gap-2 px-3 py-2.5 shrink-0"
            style={{ borderBottom: "1px solid var(--panel-border)" }}
          >
            <Radio className="w-4 h-4 text-blue-500" />
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: "var(--panel-text-muted)" }}
            >
              Live Audio Feeds
            </span>
            <span
              className="text-[10px] ml-auto"
              style={{ color: "var(--panel-text-muted)" }}
            >
              {feeds.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {feeds.map((feed) => (
              <AudioFeedCard
                key={feed.feed_id}
                feed={feed}
                activeFeedIds={activeFeedIds}
              />
            ))}
            {feeds.length === 0 && (
              <div className="text-center py-8 text-xs" style={{ color: "var(--panel-text-muted)" }}>
                No feeds available.
                <br />
                Check API connection.
              </div>
            )}
          </div>
        </div>

        {/* CENTER: Live Transcripts */}
        <div
          className="flex flex-col overflow-hidden"
          style={{
            background: "rgba(15,15,25,0.6)",
            borderRight: "1px solid var(--panel-border)",
          }}
        >
          <div
            className="flex items-center gap-2 px-3 py-2.5 shrink-0"
            style={{ borderBottom: "1px solid var(--panel-border)" }}
          >
            <FileText className="w-4 h-4 text-cyan-500" />
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: "var(--panel-text-muted)" }}
            >
              Live Transcripts
            </span>
            <span
              className="text-[10px] ml-auto"
              style={{ color: "var(--panel-text-muted)" }}
            >
              {transcriptGroups.length}
            </span>
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              className={`text-[10px] px-2 py-0.5 rounded-full ${
                autoScroll
                  ? "bg-cyan-500/15 text-cyan-500"
                  : "text-gray-500"
              }`}
            >
              {autoScroll ? "Auto-scroll" : "Paused"}
            </button>
          </div>
          <div
            className="flex-1 overflow-y-auto"
            onScroll={(e) => {
              const el = e.currentTarget;
              const nearBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              if (autoScroll !== nearBottom) setAutoScroll(nearBottom);
            }}
          >
            {transcriptGroups.length === 0 && (
              <div className="text-center py-12 text-xs" style={{ color: "var(--panel-text-muted)" }}>
                Waiting for transcripts...
              </div>
            )}
            {transcriptGroups.map((g) => (
              <TranscriptEntry
                key={g.correlation}
                group={g}
                feedLabel={feedMap.get(g.feed_id) || g.feed_id}
              />
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* RIGHT: LLM Pipeline */}
        <div
          className="flex flex-col overflow-hidden"
          style={{ background: "rgba(15,15,25,0.6)" }}
        >
          <div
            className="flex items-center gap-2 px-3 py-2.5 shrink-0"
            style={{ borderBottom: "1px solid var(--panel-border)" }}
          >
            <Brain className="w-4 h-4 text-purple-400" />
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: "var(--panel-text-muted)" }}
            >
              LLM Pipeline
            </span>
            <span
              className="text-[10px] ml-auto"
              style={{ color: "var(--panel-text-muted)" }}
            >
              {pipelineCards.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {pipelineCards.length === 0 && (
              <div className="text-center py-12 text-xs" style={{ color: "var(--panel-text-muted)" }}>
                Waiting for pipeline events...
              </div>
            )}
            {pipelineCards.map((g) => (
              <PipelineCard
                key={g.correlation}
                group={g}
                feedLabel={feedMap.get(g.feed_id) || g.feed_id}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
