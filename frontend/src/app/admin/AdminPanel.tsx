"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  ArrowLeft,
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
  Brain,
  Radio,
} from "lucide-react";
import {
  useAdminStream,
  type FeedInfo,
} from "@/hooks/useAdminStream";
import { subscribeExtractions } from "@/lib/firestore";
import type { Extraction } from "@/lib/api";
import AuthBar from "@/components/AuthBar";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

interface Props {
  onBack: () => void;
}

const TIME_FILTERS = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
  { label: "90d", hours: 24 * 90 },
  { label: "6mo", hours: 24 * 180 },
  { label: "All", hours: 0 },
] as const;

function confidenceColor(c: number): string {
  if (c >= 0.7) return "#22c55e";
  if (c >= 0.4) return "#eab308";
  return "#ef4444";
}

// ── Live Audio Header ────────────────────────────────────────────────

function LiveAudioHeader({ feed }: { feed: FeedInfo }) {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
      className="flex items-center gap-3 px-4 py-3 shrink-0"
      style={{
        background: playing
          ? "rgba(59,130,246,0.08)"
          : "var(--panel-input-bg, rgba(255,255,255,0.04))",
        borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.08))",
      }}
    >
      <Radio className="w-4 h-4 text-blue-400" />
      <span className="text-sm font-medium" style={{ color: "var(--panel-text)" }}>
        Live: {feed.label}
      </span>
      <span className="text-xs" style={{ color: "var(--panel-text-muted)" }}>
        Feed {feed.feed_id}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={toggleMute}
          className="p-1.5 rounded opacity-60 hover:opacity-100 transition-opacity"
          style={{ color: "var(--panel-text-muted)" }}
        >
          {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
        <button
          onClick={toggle}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all ${
            playing
              ? "bg-blue-500 text-white"
              : "bg-white/5 hover:bg-white/10"
          }`}
          style={!playing ? { color: "var(--panel-text-secondary)" } : {}}
        >
          {playing ? (
            <>
              <Pause className="w-3.5 h-3.5" /> Pause
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5" /> Play Live
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Extraction Card ──────────────────────────────────────────────────

function ExtractionCard({ extraction }: { extraction: Extraction }) {
  const [clipPlaying, setClipPlaying] = useState(false);
  const clipRef = useRef<HTMLAudioElement | null>(null);

  const time = (() => {
    try {
      const d = new Date(extraction.reported_at);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch {
      return "";
    }
  })();

  const date = (() => {
    try {
      const d = new Date(extraction.reported_at);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  })();

  const playClip = () => {
    if (!extraction.audio_clip) return;
    if (!clipRef.current) {
      const a = new Audio(`${API_BASE}/api/audio/${extraction.audio_clip}`);
      a.addEventListener("ended", () => setClipPlaying(false));
      a.addEventListener("error", () => setClipPlaying(false));
      clipRef.current = a;
    }
    if (clipPlaying) {
      clipRef.current.pause();
      clipRef.current.currentTime = 0;
      setClipPlaying(false);
    } else {
      clipRef.current.play().catch(() => setClipPlaying(false));
      setClipPlaying(true);
    }
  };

  useEffect(() => {
    return () => {
      clipRef.current?.pause();
    };
  }, []);

  const dimmed = !extraction.llm_relevant;

  return (
    <div
      className={`rounded-lg overflow-hidden transition-all ${dimmed ? "opacity-60" : ""}`}
      style={{
        background: "var(--panel-input-bg, rgba(255,255,255,0.04))",
        border: `1px solid ${
          dimmed
            ? "var(--panel-border, rgba(255,255,255,0.04))"
            : "var(--panel-border, rgba(255,255,255,0.08))"
        }`,
      }}
    >
      {/* Header: timestamp + audio */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--panel-border)" }}>
        <span className="text-xs font-medium" style={{ color: "var(--panel-text)" }}>
          {time}
        </span>
        <span className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
          {date}
        </span>

        {!extraction.llm_relevant && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-400 font-medium">
            Not Relevant
          </span>
        )}

        <div className="ml-auto">
          {extraction.audio_clip ? (
            <button
              onClick={playClip}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-all ${
                clipPlaying
                  ? "bg-blue-500 text-white"
                  : "bg-white/5 hover:bg-white/10"
              }`}
              style={!clipPlaying ? { color: "var(--panel-text-secondary)" } : {}}
            >
              {clipPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              Audio
            </button>
          ) : (
            <span className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
              No audio
            </span>
          )}
        </div>
      </div>

      {/* Transcript text */}
      <div className="px-3 py-2.5">
        <p className="text-xs leading-relaxed" style={{ color: "var(--panel-text, #e5e7eb)" }}>
          {extraction.raw_text}
        </p>
      </div>

      {/* LLM Decision + Pipeline Row */}
      <div
        className="px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]"
        style={{
          borderTop: "1px solid var(--panel-border)",
          background: "rgba(0,0,0,0.15)",
        }}
      >
        {/* Relevant status */}
        <div className="flex items-center gap-1.5">
          <Brain className="w-3 h-3 text-purple-400" />
          <span style={{ color: "var(--panel-text-muted)" }}>LLM:</span>
          <span style={{ color: extraction.llm_relevant ? "#22c55e" : "#6b7280" }}>
            {extraction.llm_relevant ? "Relevant" : "Rejected"}
            {extraction.llm_relevant ? " \u2713" : " \u2717"}
          </span>
        </div>

        {/* Category */}
        {extraction.llm_category && (
          <div className="flex items-center gap-1.5">
            <span style={{ color: "var(--panel-text-muted)" }}>Category:</span>
            <span style={{ color: "var(--panel-text)" }}>
              {extraction.llm_category.replace(/_/g, " ")}
            </span>
          </div>
        )}

        {/* Confidence */}
        {extraction.llm_confidence > 0 && (
          <div className="flex items-center gap-1.5">
            <span style={{ color: "var(--panel-text-muted)" }}>Conf:</span>
            <span style={{ color: confidenceColor(extraction.llm_confidence) }}>
              {(extraction.llm_confidence * 100).toFixed(0)}%
            </span>
          </div>
        )}

        {/* Inhibitor */}
        {extraction.inhibitor_status && (
          <div className="flex items-center gap-1.5">
            <Shield className="w-3 h-3" style={{ color: "var(--panel-text-muted)" }} />
            <span style={{ color: "var(--panel-text-muted)" }}>Inhibitor:</span>
            <span
              style={{
                color:
                  extraction.inhibitor_status === "passed"
                    ? "#22c55e"
                    : extraction.inhibitor_status === "blocked"
                      ? "#ef4444"
                      : "#eab308",
              }}
            >
              {extraction.inhibitor_status}
            </span>
          </div>
        )}

        {/* Geocode */}
        {extraction.geocode_status && (
          <div className="flex items-center gap-1.5">
            <MapPin className="w-3 h-3" style={{ color: "var(--panel-text-muted)" }} />
            <span style={{ color: "var(--panel-text-muted)" }}>Geocode:</span>
            <span
              style={{
                color:
                  extraction.geocode_status === "success"
                    ? "#22c55e"
                    : extraction.geocode_status === "llm_fallback"
                      ? "#eab308"
                      : "#6b7280",
              }}
            >
              {extraction.geocode_status}
            </span>
          </div>
        )}

        {/* Stored indicator */}
        {extraction.incident_id ? (
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="w-3 h-3 text-green-500" />
            <span style={{ color: "#22c55e" }}>Stored</span>
          </div>
        ) : extraction.llm_relevant && extraction.inhibitor_status === "blocked" ? (
          <div className="flex items-center gap-1.5">
            <XCircle className="w-3 h-3 text-red-500" />
            <span style={{ color: "#ef4444" }}>Blocked</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Feed Tab Content ─────────────────────────────────────────────────

function FeedTabContent({ feed }: { feed: FeedInfo }) {
  const [timeFilter, setTimeFilter] = useState(24);
  const [extractions, setExtractions] = useState<Extraction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const now = new Date();
    const since =
      timeFilter === 0
        ? new Date(0)
        : new Date(now.getTime() - timeFilter * 60 * 60 * 1000);

    const unsub = subscribeExtractions(
      feed.feed_id,
      since,
      now,
      (data) => {
        setExtractions(data);
        setLoading(false);
      },
      () => setLoading(false)
    );

    return unsub;
  }, [feed.feed_id, timeFilter]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Live audio player */}
      <LiveAudioHeader feed={feed} />

      {/* Date range filter */}
      <div
        className="flex items-center gap-1.5 px-4 py-2.5 shrink-0 overflow-x-auto"
        style={{ borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.08))" }}
      >
        <span className="text-[10px] font-semibold uppercase mr-2" style={{ color: "var(--panel-text-muted)" }}>
          Range:
        </span>
        {TIME_FILTERS.map((tf) => (
          <button
            key={tf.label}
            onClick={() => setTimeFilter(tf.hours)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-all whitespace-nowrap ${
              timeFilter === tf.hours
                ? "bg-blue-500 text-white"
                : "bg-white/5 hover:bg-white/10"
            }`}
            style={
              timeFilter !== tf.hours
                ? { color: "var(--panel-text-secondary)" }
                : {}
            }
          >
            {tf.label}
          </button>
        ))}
        <span className="ml-auto text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
          {extractions.length} extractions
        </span>
      </div>

      {/* Extraction list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading && (
          <div className="text-center py-12 text-xs" style={{ color: "var(--panel-text-muted)" }}>
            Loading extractions...
          </div>
        )}
        {!loading && extractions.length === 0 && (
          <div className="text-center py-12 text-xs" style={{ color: "var(--panel-text-muted)" }}>
            No extractions found for this feed in the selected time range.
          </div>
        )}
        {extractions.map((e) => (
          <ExtractionCard key={e.id} extraction={e} />
        ))}
      </div>
    </div>
  );
}

// ── Main Admin Panel ────────────────────────────────────────────────

export default function AdminPanel({ onBack }: Props) {
  const { connected, feeds, events } = useAdminStream();
  const [activeTab, setActiveTab] = useState<string | null>(null);

  const activeFeedIds = new Set(
    events
      .filter((e) => e.type === "transcript_received")
      .slice(-50)
      .map((e) => e.feed_id)
  );

  const setInitialTab = useCallback(() => {
    if (activeTab === null && feeds.length > 0) {
      setActiveTab(feeds[0].feed_id);
    }
  }, [activeTab, feeds]);

  useEffect(() => {
    setInitialTab();
  }, [setInitialTab]);

  const activeFeed = feeds.find((f) => f.feed_id === activeTab);

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

        <img src="/logo.png" alt="PHLPulse" className="w-5 h-5" />
        <span className="text-sm font-semibold" style={{ color: "var(--panel-text)" }}>
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

        <div className="ml-auto">
          <AuthBar />
        </div>
      </div>

      {/* Tab bar */}
      <div
        className="flex items-center gap-0.5 px-2 shrink-0 overflow-x-auto"
        style={{
          background: "var(--panel-bg, rgba(15,15,25,0.95))",
          borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.08))",
        }}
      >
        {feeds.map((feed) => {
          const isActive = feed.feed_id === activeTab;
          const hasActivity = activeFeedIds.has(feed.feed_id);
          return (
            <button
              key={feed.feed_id}
              onClick={() => setActiveTab(feed.feed_id)}
              className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap transition-all border-b-2 ${
                isActive
                  ? "border-blue-500"
                  : "border-transparent hover:border-white/10"
              }`}
              style={{
                color: isActive
                  ? "var(--panel-text, #e5e7eb)"
                  : "var(--panel-text-muted, #6b7280)",
              }}
            >
              {hasActivity && (
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              )}
              {feed.label}
            </button>
          );
        })}
        {feeds.length === 0 && (
          <div className="px-3 py-2 text-xs" style={{ color: "var(--panel-text-muted)" }}>
            No feeds available. Check API connection.
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "rgba(15,15,25,0.6)" }}>
        {activeFeed ? (
          <FeedTabContent key={activeFeed.feed_id} feed={activeFeed} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <AlertTriangle className="w-8 h-8 mx-auto mb-3 text-yellow-500/50" />
              <p className="text-sm" style={{ color: "var(--panel-text-muted)" }}>
                Select a feed tab to view extractions
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
