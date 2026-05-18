"use client";

import { useEffect, useState } from "react";
import { Play, X, Navigation } from "lucide-react";

interface Props {
  destName: string;
  /** ms epoch when the trip started — drives the "started Xm ago" copy. */
  startedAt: number;
  onResume: () => void;
  onDismiss: () => void;
}

function fmtAgo(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ago`;
}

/** Top-anchored pill prompting the user to pick up where their trip
 *  left off after a refresh / accidental tab close. Mirrors the visual
 *  language of OffscreenIncidentChip / IncidentAheadChip so the alert
 *  surfaces feel cohesive. The positioning class keeps it out of the
 *  floating search lane on both mobile and desktop. */
export default function ResumeTripPill({
  destName,
  startedAt,
  onResume,
  onDismiss,
}: Props) {
  const [enter, setEnter] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setEnter(true));
    return () => cancelAnimationFrame(t);
  }, []);

  return (
    <div
      className="pp-resume-trip-pill pointer-events-none fixed inset-x-0 z-[1100] flex justify-center px-3"
      style={{
        opacity: enter ? 1 : 0,
        transform: enter ? "translateY(0)" : "translateY(-8px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
      }}
    >
      <div
        className="pointer-events-auto w-full max-w-md flex items-center gap-3 px-3 py-2.5 rounded-full backdrop-blur-xl shadow-2xl"
        style={{
          background: "var(--panel-bg)",
          border: "1px solid rgba(59,130,246,0.55)",
          boxShadow: "0 8px 32px rgba(59,130,246,0.33), 0 2px 8px rgba(0,0,0,0.25)",
        }}
        role="dialog"
        aria-label="Resume previous trip"
      >
        <div
          className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center"
          style={{ background: "rgba(59,130,246,0.18)", color: "#3b82f6" }}
        >
          <Navigation className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold leading-tight uppercase tracking-wide" style={{ color: "#3b82f6" }}>
            Resume trip?
          </p>
          <p className="text-xs leading-tight truncate mt-0.5" style={{ color: "var(--panel-text-secondary)" }}>
            To {destName} · started {fmtAgo(startedAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={onResume}
          className="shrink-0 flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider transition-colors"
          style={{ background: "#3b82f6", color: "#fff" }}
        >
          <Play className="w-3 h-3 fill-current" /> Resume
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss resume prompt"
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors"
          style={{ color: "var(--panel-text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
