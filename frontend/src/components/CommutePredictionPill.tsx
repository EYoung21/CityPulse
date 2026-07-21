"use client";

import { useEffect, useMemo, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { useSavedDestinations } from "@/hooks/useSavedDestinations";
import { subscribeTripHistory } from "@/lib/trip-history";
import {
  formatDepartureTime,
  predictNextCommute,
  type CommutePrediction,
} from "@/lib/commute-patterns";

const DISMISS_KEY = "pp:commute-pill-dismissed-v1";

interface DismissRecord {
  /** YYYY-MM-DD */
  date: string;
  /** bucketKey (`wd:17` etc.) we last dismissed today. */
  bucketKey: string;
}

function loadDismiss(): DismissRecord | null {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DismissRecord;
    if (
      parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) &&
      typeof parsed.bucketKey === "string" && parsed.bucketKey.length <= 200
    ) {
      return { date: parsed.date, bucketKey: parsed.bucketKey };
    }
  } catch { /* ignore */ }
  return null;
}

function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Props {
  onPlan: (label: string, dest: { lat: number; lng: number }) => void;
}

/** Passive nudge that surfaces when the user is near a recurring
 *  trip's typical departure time (see `lib/commute-patterns`). Sits
 *  in the search-bar shortcuts row, alongside Home/Work pills. Once
 *  dismissed it stays hidden for the same time-of-day bucket until
 *  the next calendar day, so we don't pester. */
export default function CommutePredictionPill({ onPlan }: Props) {
  const { destinations } = useSavedDestinations();
  const [tick, setTick] = useState(0);
  const [dismissed, setDismissed] = useState<DismissRecord | null>(() =>
    typeof window === "undefined" ? null : loadDismiss()
  );

  // Re-evaluate on trip-history changes (a fresh trip can flip a
  // cluster from 2 → 3 samples and unlock a prediction) and on a
  // 1-minute interval so the pill appears/disappears as "now" walks
  // into and out of the match window without needing a refresh.
  useEffect(() => {
    const unsub = subscribeTripHistory(() => setTick((n) => n + 1));
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => { unsub(); window.clearInterval(id); };
  }, []);

  const prediction: CommutePrediction | null = useMemo(() => {
    void tick;
    return predictNextCommute(destinations);
  }, [destinations, tick]);

  if (!prediction) return null;

  // If today's dismissal record matches the current prediction's
  // bucket, don't render. New day or a different bucket and we
  // surface again — keeps the nudge low-friction without becoming
  // permanent visual noise.
  const today = todayKey();
  if (dismissed && dismissed.date === today && dismissed.bucketKey === prediction.bucketKey) {
    return null;
  }

  // We deliberately suppress the prediction when it would shadow
  // the existing Home/Work chip exactly. Showing both "Home" and
  // "Heading home (5:42 PM)" is redundant — the chip alone is fine
  // and the prediction subtitle would just add noise.
  if (prediction.matchedCategory && prediction.confidence < 0.5) return null;

  const nowMinute = new Date().getHours() * 60 + new Date().getMinutes();
  const minutesUntil = Math.round(prediction.typicalDepartureMinute - nowMinute);
  const lead =
    minutesUntil > 5
      ? `in ${minutesUntil}m`
      : minutesUntil < -5
        ? `${Math.abs(minutesUntil)}m late`
        : "now";

  const label =
    prediction.matchedCategory === "home"
      ? "Heading home"
      : prediction.matchedCategory === "work"
        ? "Heading to work"
        : `Heading to ${prediction.destLabel}`;

  const subtitle = `${formatDepartureTime(prediction.typicalDepartureMinute)} · ~${Math.round(prediction.typicalDurationMin)}m`;

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rec: DismissRecord = { date: today, bucketKey: prediction.bucketKey };
    setDismissed(rec);
    try { window.localStorage.setItem(DISMISS_KEY, JSON.stringify(rec)); } catch { /* ignore */ }
  };

  // Two-button layout (planning vs dismiss) glued together so it
  // visually reads as a single pill without violating the no-nested-
  // <button> HTML rule.
  return (
    <div
      className="shrink-0 inline-flex items-stretch rounded-full text-xs font-medium overflow-hidden"
      style={{
        background: "rgba(168,85,247,0.12)",
        color: "#a855f7",
        border: "1px solid rgba(168,85,247,0.35)",
      }}
    >
      <button
        type="button"
        onClick={() =>
          onPlan(prediction.destLabel, { lat: prediction.destLat, lng: prediction.destLng })
        }
        className="inline-flex items-center gap-2 pl-3 pr-2 py-1.5 transition-colors active:scale-[0.98]"
        title={`Plan ${label.toLowerCase()} · ${subtitle} · based on ${prediction.sampleSize} trips`}
        aria-label={`Plan ${label}, typical departure ${formatDepartureTime(prediction.typicalDepartureMinute)}, ${lead}`}
      >
        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
        <span className="flex flex-col items-start leading-tight text-left">
          <span>{label}</span>
          <span className="text-[10px] opacity-80">{subtitle} · {lead}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        className="inline-flex items-center justify-center w-7 transition-colors hover:bg-white/10"
        aria-label="Dismiss commute prediction"
        title="Hide for today"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
