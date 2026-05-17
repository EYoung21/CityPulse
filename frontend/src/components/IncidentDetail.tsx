"use client";

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import type { Incident, IncidentMention } from "@/lib/api";
import { getSeverity } from "@/lib/severity";
import { incidentHeadline, incidentLocationLabel } from "@/lib/incident-display";
import { withAlpha } from "@/lib/colors";
import {
  MapPin,
  Clock,
  Brain,
  Shield,
  X,
  Radio,
  Pause,
  Play,
  RotateCcw,
  Volume2,
} from "lucide-react";
import PlaceActions from "@/components/PlaceActions";
import {
  incidentAudioSrc,
  incidentAudioSources,
  fetchUrlWithPublicApiFallback,
} from "@/lib/public-api-base";
import {
  hasScannerTranscriptArtifacts,
  sanitizeScannerTranscriptForDisplay,
} from "@/lib/sanitize-scanner-transcript";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${date}, ${time}`;
}

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function WaveformPlayer({
  src,
  transcript,
  wordTimings,
}: {
  /** One or more candidate URLs, tried in order. When the backend is
   *  unhealthy and the primary times out, the player falls back to
   *  the next candidate (e.g. raw `audio_url` → GCS) without surfacing
   *  the error to the user until everything is exhausted. */
  src: string | string[];
  transcript: string;
  wordTimings?: { word: string; start: number; end: number }[] | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animRef = useRef<number>(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);

  const { words, effectiveHasTimings } = useMemo(() => {
    const hasTimings = !!(wordTimings && wordTimings.length > 0);
    const baseSource = hasTimings
      ? wordTimings!.map((w) => w.word).join(" ")
      : transcript;
    const junk = hasScannerTranscriptArtifacts(baseSource);
    const displaySource = junk ? sanitizeScannerTranscriptForDisplay(baseSource) : baseSource;
    const effectiveHasTimings = hasTimings && !junk;
    const words = effectiveHasTimings
      ? wordTimings!.map((wt) => wt.word)
      : displaySource.split(/\s+/).filter(Boolean);
    return { words, effectiveHasTimings };
  }, [transcript, wordTimings]);

  // Stable string identifier for the audio source set. The parent
  // (IncidentDetail) re-derives `incident` on every live-feed tick,
  // which yields a fresh `src` array reference even when the URLs
  // haven't changed. Keying the fetch+playback effect on the array
  // reference (`[src]`) tore the audio element down mid-playback —
  // calling `audio.pause()` + `audio.src = ""` and resetting the
  // user's position. Keying on the joined URL string keeps the
  // effect stable across no-op parent renders.
  const srcKey = useMemo(
    () => (Array.isArray(src) ? src.filter(Boolean).join("|") : (src ?? "")),
    [src]
  );

  useEffect(() => {
    let objectUrl: string | null = null;
    const audio = new Audio();
    audioRef.current = audio;

    audio.addEventListener("loadedmetadata", () => setDuration(audio.duration));
    audio.addEventListener("ended", () => setPlaying(false));
    audio.addEventListener("error", () => setPlaying(false));

    const candidates = Array.isArray(src) ? src.filter(Boolean) : [src];
    let cancelled = false;

    /** Try each candidate URL in order. Resolves with the first
     *  successful response; the rejection only fires after every
     *  candidate has failed. Logs each individual failure so the
     *  fallback chain is visible in DevTools. */
    const fetchFirstAvailable = async () => {
      let lastErr: unknown = null;
      for (const url of candidates) {
        if (cancelled) return null;
        try {
          const r = await fetchUrlWithPublicApiFallback(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const buf = await r.arrayBuffer();
          return { url, buf, mime: r.headers.get("content-type") };
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : "network error";
          console.warn("[WaveformPlayer] candidate failed", { url, error: msg });
        }
      }
      throw lastErr ?? new Error("no audio sources available");
    };

    fetchFirstAvailable()
      .then(async (res) => {
        if (cancelled || !res) return;
        const { buf, mime } = res;
        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(buf.slice(0));
        const raw = decoded.getChannelData(0);
        const bars = 60;
        const blockSize = Math.floor(raw.length / bars);
        const samples: number[] = [];
        for (let i = 0; i < bars; i++) {
          let sum = 0;
          for (let j = 0; j < blockSize; j++) {
            sum += Math.abs(raw[i * blockSize + j]);
          }
          samples.push(sum / blockSize);
        }
        const max = Math.max(...samples, 0.01);
        setWaveformData(samples.map((s) => s / max));
        setLoadError(null);

        const type = mime && mime.startsWith("audio/") ? mime : "audio/mpeg";
        objectUrl = URL.createObjectURL(new Blob([buf], { type }));
        audio.src = objectUrl;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "network error";
        console.warn("[WaveformPlayer] all audio sources failed", {
          tried: candidates,
          error: msg,
        });
        setLoadError(msg);
      });

    return () => {
      cancelled = true;
      audio.pause();
      audio.src = "";
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!canvas || !audio || waveformData.length === 0) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    const barW = w / waveformData.length;
    const progress = audio.duration > 0 ? audio.currentTime / audio.duration : 0;

    for (let i = 0; i < waveformData.length; i++) {
      const barH = Math.max(2, waveformData[i] * (h - 4));
      const x = i * barW;
      const y = (h - barH) / 2;
      const isPast = i / waveformData.length <= progress;

      ctx.fillStyle = isPast ? "#3b82f6" : "rgba(255,255,255,0.15)";
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y, barW - 1, barH, 1);
      ctx.fill();
    }

    setCurrentTime(audio.currentTime);
  }, [waveformData]);

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      drawWaveform();
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [playing, drawWaveform]);

  useEffect(() => {
    drawWaveform();
  }, [waveformData, drawWaveform]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (loadError || !audioRef.current.src) return;
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "playback blocked";
        console.warn("[WaveformPlayer] audio.play() failed", { error: msg });
        setLoadError(msg);
        setPlaying(false);
      });
      setPlaying(true);
    }
  };

  const restart = () => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = 0;
    drawWaveform();
  };

  const seek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = pct * duration;
    drawWaveform();
  };

  const currentWordIdx = (() => {
    if (words.length === 0 || duration <= 0) return -1;
    if (effectiveHasTimings && wordTimings) {
      for (let i = wordTimings.length - 1; i >= 0; i--) {
        if (currentTime >= wordTimings[i].start) return i;
      }
      return -1;
    }
    return Math.min(Math.floor((currentTime / duration) * words.length), words.length - 1);
  })();

  useEffect(() => {
    if (currentWordIdx < 0 || !transcriptContainerRef.current) return;
    const el = transcriptContainerRef.current.children[currentWordIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentWordIdx]);

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={restart}
          disabled={!!loadError}
          className="p-1.5 rounded-full transition-colors disabled:opacity-40"
          style={{ color: "var(--panel-text-muted)" }}
          title="Restart"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={togglePlay}
          disabled={!!loadError}
          className={`p-2 rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
            playing ? "bg-blue-500 text-white" : "bg-blue-500/15 text-blue-400 hover:bg-blue-500/25"
          }`}
          title={loadError ? `Audio unavailable: ${loadError}` : undefined}
        >
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
        <canvas
          ref={canvasRef}
          onClick={seek}
          className="flex-1 h-10 cursor-pointer rounded"
        />
        <span className="text-[10px] font-mono shrink-0" style={{ color: "var(--panel-text-muted)" }}>
          {fmtTime(currentTime)} / {fmtTime(duration)}
        </span>
      </div>

      {loadError && (
        <div
          className="text-[11px] px-2 py-1 rounded"
          style={{
            color: "rgb(252, 165, 165)",
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.25)",
          }}
          role="alert"
        >
          Audio unavailable &middot; {loadError}
        </div>
      )}

      {words.length > 0 && (
        <div
          ref={transcriptContainerRef}
          className="max-h-20 overflow-y-auto text-xs leading-relaxed flex flex-wrap gap-x-1"
          style={{ color: "var(--panel-text-secondary)" }}
        >
          {words.map((word, idx) => (
            <span
              key={idx}
              className="transition-colors duration-150"
              style={{
                backgroundColor:
                  idx === currentWordIdx && playing ? "rgba(59,130,246,0.3)" : "transparent",
                borderRadius: idx === currentWordIdx && playing ? "2px" : "0",
                padding: idx === currentWordIdx && playing ? "0 2px" : "0",
                cursor: effectiveHasTimings ? "pointer" : "default",
              }}
              onClick={() => {
                if (effectiveHasTimings && audioRef.current && wordTimings) {
                  audioRef.current.currentTime = wordTimings[idx].start;
                  drawWaveform();
                }
              }}
            >
              {word}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  incident: Incident;
  onClose: () => void;
}

export default function IncidentDetail({ incident, onClose }: Props) {
  const sev = getSeverity(incident.severity_category);
  const confidencePct = Math.round(incident.confidence * 100);
  // Memoize the candidate list so a parent re-render doesn't hand the
  // player a fresh array reference and trigger a re-fetch on every tick.
  const audioSources = useMemo(
    () => incidentAudioSources(incident),
    [incident],
  );
  const audioSrc = audioSources[0] ?? null;
  const hasAudio = !!audioSrc;

  // Mentions are appended chronologically by the dedup pipeline. We
  // render them oldest-first so the "story" reads naturally (initial
  // dispatch at top, follow-ups below). The very first mention is
  // already represented by the main transcript block above, so trim
  // it off to avoid duplication.
  const updateMentions = useMemo<IncidentMention[]>(() => {
    const all = incident.mentions ?? [];
    if (all.length <= 1) return [];
    const sorted = [...all].sort((a, b) =>
      (a.at || "").localeCompare(b.at || "")
    );
    return sorted.slice(1);
  }, [incident.mentions]);
  const mentionCount = incident.mention_count ?? incident.mentions?.length ?? 0;

  return (
    <div
      className="rounded-xl overflow-hidden backdrop-blur-xl shadow-2xl"
      style={{ background: "var(--panel-bg)", border: "1px solid var(--panel-border)" }}
    >
      <div
        className="h-1"
        style={{ background: `linear-gradient(90deg, ${sev.markerColor}, transparent)` }}
      />

      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md"
                style={{ backgroundColor: withAlpha(sev.markerColor, 13), color: sev.markerColor }}
              >
                {sev.label}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <h3
                className="font-semibold text-sm"
                style={{ color: "var(--panel-text)" }}
              >
                {incidentHeadline(incident)}
              </h3>
              {incident.location_confidence === "context" && (
                <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-500">
                  Nearby Context
                </span>
              )}
            </div>
            <p
              className="mt-1 text-xs flex items-center gap-1.5"
              style={{ color: "var(--panel-text-secondary)" }}
            >
              <MapPin className="w-3.5 h-3.5 shrink-0" />
              {incidentLocationLabel(incident)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="transition-colors p-1.5 -m-1.5"
            style={{ color: "var(--panel-text-muted)" }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div
          className="flex items-center gap-4 text-xs font-mono"
          style={{ color: "var(--panel-text-secondary)" }}
        >
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            {formatTime(incident.reported_at)}
          </span>
          <span style={{ color: "var(--panel-border)" }}>|</span>
          <span className="flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5" />
            {incident.lat?.toFixed(4)}, {incident.lng?.toFixed(4)}
          </span>
        </div>

        <div className="h-px" style={{ background: "var(--panel-border)" }} />

        {incident.description && (
          <div className="rounded-lg p-3.5" style={{ background: "var(--panel-input-bg)" }}>
            <p className="text-[11px] text-blue-500 font-mono font-medium flex items-center gap-1 mb-2">
              SUMMARY
            </p>
            <p className="text-sm leading-relaxed" style={{ color: "var(--panel-text)" }}>
              {incident.description}
            </p>
          </div>
        )}

        <div className="rounded-lg p-3.5" style={{ background: "var(--panel-input-bg)" }}>
          <p className="text-[11px] text-blue-500 font-mono font-medium flex items-center gap-1 mb-2">
            <Radio className="w-3.5 h-3.5" /> SCANNER TRANSCRIPT
          </p>

          {hasAudio ? (
            <WaveformPlayer
              src={audioSources}
              transcript={incident.raw_text}
              wordTimings={incident.word_timings}
            />
          ) : (
            <p
              className="text-sm leading-relaxed italic"
              style={{ color: "var(--panel-text-secondary)" }}
            >
              &ldquo;{sanitizeScannerTranscriptForDisplay(incident.raw_text)}&rdquo;
            </p>
          )}

          {!hasAudio && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--panel-text-muted)" }}>
              <Volume2 className="w-3.5 h-3.5" />
              Audio not available
            </div>
          )}
        </div>

        <div className="flex gap-3">
          {[
            {
              label: "CONFIDENCE",
              value: `${confidencePct}%`,
              color:
                confidencePct >= 80
                  ? "#22c55e"
                  : confidencePct >= 50
                    ? "#f59e0b"
                    : "#ef4444",
            },
            { label: "SEVERITY", value: incident.s_base.toFixed(1), color: sev.markerColor },
            {
              label: "WEIGHT",
              value: incident.w_eff.toFixed(2),
              color: "var(--panel-text-secondary)",
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className="flex-1 rounded-lg p-3 text-center"
              style={{ background: "var(--panel-input-bg)" }}
            >
              <p
                className="text-[10px] font-mono mb-0.5"
                style={{ color: "var(--panel-text-muted)" }}
              >
                {stat.label}
              </p>
              <p className="text-base font-bold font-mono" style={{ color: stat.color }}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        {incident.lat != null && incident.lng != null && (
          <div className="pt-1" style={{ borderTop: "1px solid var(--panel-border)" }}>
            <div className="pt-2.5">
              <PlaceActions
                lat={incident.lat}
                lng={incident.lng}
                label={incident.location_text ?? undefined}
                incidentId={incident.id}
                incidentCategory={incident.severity_category}
                incidentTime={incident.reported_at}
              />
            </div>
          </div>
        )}

        {updateMentions.length > 0 && (
          <div className="rounded-lg p-3" style={{ background: "var(--panel-input-bg)" }}>
            <p className="text-[10px] text-blue-500 font-mono font-medium flex items-center gap-1 mb-2">
              <Radio className="w-3 h-3" />
              UPDATES ({mentionCount})
            </p>
            <ul className="space-y-2">
              {updateMentions.map((m, idx) => {
                const mAudioSrc = incidentAudioSrc(m);
                return (
                  <li
                    key={`${m.at}-${idx}`}
                    className="text-xs leading-relaxed pl-2 border-l-2"
                    style={{
                      borderColor: withAlpha(sev.markerColor, 33),
                      color: "var(--panel-text)",
                    }}
                  >
                    <div
                      className="text-[10px] font-mono mb-1 flex items-center gap-2"
                      style={{ color: "var(--panel-text-muted)" }}
                    >
                      <Clock className="w-2.5 h-2.5" />
                      Updated {timeAgoShort(m.at)}
                      {m.feed_id && (
                        <>
                          <span style={{ color: "var(--panel-border)" }}>·</span>
                          <span>feed {m.feed_id}</span>
                        </>
                      )}
                    </div>
                    <p
                      className="italic"
                      style={{ color: "var(--panel-text-secondary)" }}
                    >
                      &ldquo;{sanitizeScannerTranscriptForDisplay(m.raw_text)}&rdquo;
                    </p>
                    {mAudioSrc && (
                      <audio
                        src={mAudioSrc}
                        controls
                        preload="none"
                        className="w-full mt-1.5 h-7"
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {incident.inhibitor_status !== "passed" && (
          <div className="flex items-center gap-2 text-xs text-amber-500 bg-amber-500/10 rounded-lg px-3 py-2">
            <Shield className="w-3.5 h-3.5" />
            <span className="font-mono text-[10px]">
              INHIBITOR: {incident.inhibitor_status.toUpperCase()}
              {incident.inhibitor_reason && ` -- ${incident.inhibitor_reason}`}
            </span>
          </div>
        )}

        <div
          className="flex items-center gap-2 text-[10px] pt-1"
          style={{ color: "var(--panel-text-muted)" }}
        >
          <Brain className="w-3 h-3" />
          <span>Processed by AI pipeline with ethical guardrails</span>
          {incident.inhibitor_status === "passed" && (
            <Shield className="w-3 h-3 text-green-500/50" />
          )}
        </div>
      </div>
    </div>
  );
}
