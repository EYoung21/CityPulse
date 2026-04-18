"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  ArrowUpLeft,
  CornerUpRight,
  CornerUpLeft,
  RotateCcw,
  Flag,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import type { ManeuverStep } from "@/lib/routing";

interface Props {
  steps: ManeuverStep[];
  geometry: [number, number][];
  /** 0..1 progress along the geometry. */
  tripProgress: number;
  /** Optional callback fired when the user taps the "Steps" button on
   *  the chip. The host (page.tsx) opens the full TurnList overlay. */
  onShowSteps?: () => void;
}

/** ORS maneuver type → icon. Reference (ORS docs):
 *   0 left, 1 right, 2 sharp left, 3 sharp right, 4 slight left, 5 slight right,
 *   6 straight, 7 enter roundabout, 8 exit roundabout, 9 u-turn,
 *  10 goal (arrive), 11 depart, 12 keep left, 13 keep right
 */
const MANEUVER_ICON: Record<number, LucideIcon> = {
  0: CornerUpLeft,
  1: CornerUpRight,
  2: CornerUpLeft,
  3: CornerUpRight,
  4: ArrowUpLeft,
  5: ArrowUpRight,
  6: ArrowUp,
  7: RotateCcw,
  8: RotateCcw,
  9: RotateCcw,
  10: Flag,
  11: ArrowUp,
  12: ArrowUpLeft,
  13: ArrowUpRight,
};

const VOICE_PREF_KEY = "pp:voice-nav-enabled";

function fmtMeters(m: number): string {
  if (m < 50) return `${Math.round(m / 5) * 5} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/** Floating turn-by-turn pill rendered above the TripHUD / sidebar. Picks the
 *  step whose `way_points` window contains the current geometry index, derives
 *  remaining distance to that maneuver point, and announces the next
 *  instruction once via SpeechSynthesis at two thresholds (~300m and ~50m).
 *  Voice can be muted; preference persists in localStorage. */
export default function ManeuverChip({ steps, geometry, tripProgress, onShowSteps }: Props) {
  const [muted, setMuted] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(VOICE_PREF_KEY) === "off";
  });
  const lastSpokenRef = useRef<{ stepIdx: number; level: 0 | 1 | 2 } | null>(null);

  const currentIdx = Math.min(
    geometry.length - 1,
    Math.max(0, Math.floor(tripProgress * (geometry.length - 1)))
  );

  const { step, stepIdx, distanceToManeuver } = useMemo(() => {
    if (steps.length === 0) {
      return { step: null as ManeuverStep | null, stepIdx: -1, distanceToManeuver: 0 };
    }
    let foundIdx = steps.findIndex(
      (s) => currentIdx >= s.way_points[0] && currentIdx <= s.way_points[1]
    );
    if (foundIdx === -1) {
      foundIdx = steps.findIndex((s) => s.way_points[1] >= currentIdx);
      if (foundIdx === -1) foundIdx = steps.length - 1;
    }
    const s = steps[foundIdx];
    const remainingPts = Math.max(0, s.way_points[1] - currentIdx);
    let dist = 0;
    for (let i = 0; i < remainingPts && currentIdx + i < geometry.length - 1; i++) {
      const a = geometry[currentIdx + i];
      const b = geometry[currentIdx + i + 1];
      dist += haversine(a[0], a[1], b[0], b[1]);
    }
    return { step: s, stepIdx: foundIdx, distanceToManeuver: dist };
  }, [steps, geometry, currentIdx]);

  useEffect(() => {
    localStorage.setItem(VOICE_PREF_KEY, muted ? "off" : "on");
  }, [muted]);

  useEffect(() => {
    if (muted || !step || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    let level: 0 | 1 | 2 = 0;
    if (distanceToManeuver < 60) level = 2;
    else if (distanceToManeuver < 320) level = 1;
    else return;

    const last = lastSpokenRef.current;
    if (last && last.stepIdx === stepIdx && last.level >= level) return;
    lastSpokenRef.current = { stepIdx, level };

    const phrase =
      level === 2
        ? `Now, ${step.instruction}`
        : `In ${fmtMeters(distanceToManeuver)}, ${step.instruction}`;
    speak(phrase);
  }, [step, stepIdx, distanceToManeuver, muted]);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
      }
    };
  }, []);

  if (!step) return null;
  const Icon = MANEUVER_ICON[step.type] ?? ArrowUp;
  const arriving = step.type === 10 || stepIdx === steps.length - 1;
  const accent = arriving ? "#22c55e" : "#3b82f6";

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto inline-flex items-center gap-3 px-3 py-2 rounded-2xl shadow-2xl backdrop-blur-xl max-w-[calc(100vw-2rem)]"
      style={{
        background: "var(--panel-bg)",
        border: `1px solid ${accent}40`,
        color: "var(--panel-text)",
      }}
    >
      <div
        className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center"
        style={{ background: `${accent}1a`, color: accent }}
      >
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: accent }}>
          {arriving ? "Arriving" : `In ${fmtMeters(distanceToManeuver)}`}
        </p>
        <p className="text-sm leading-snug truncate" title={step.instruction}>
          {step.instruction}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setMuted((m) => !m)}
        title={muted ? "Unmute voice guidance" : "Mute voice guidance"}
        aria-label={muted ? "Unmute voice guidance" : "Mute voice guidance"}
        aria-pressed={muted}
        className="shrink-0 w-8 h-8 rounded-lg inline-flex items-center justify-center"
        style={{
          background: "var(--panel-input-bg)",
          color: muted ? "var(--panel-text-muted)" : accent,
          border: "1px solid var(--panel-border)",
        }}
      >
        {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
      </button>
      {onShowSteps && (
        <button
          type="button"
          onClick={onShowSteps}
          title="Show all turn-by-turn steps"
          aria-label="Show all turn-by-turn steps"
          className="shrink-0 px-2 h-8 rounded-lg inline-flex items-center justify-center text-[10px] font-bold uppercase tracking-wider"
          style={{
            background: "var(--panel-input-bg)",
            color: "var(--panel-text-secondary)",
            border: "1px solid var(--panel-border)",
          }}
        >
          Steps
        </button>
      )}
    </div>
  );
}

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function speak(text: string) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.pitch = 1;
    u.volume = 1;
    u.lang = "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    /* speech denied or unsupported */
  }
}
