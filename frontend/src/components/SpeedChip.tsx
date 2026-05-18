"use client";

import { useEffect, useRef } from "react";
import { Gauge } from "lucide-react";
import { formatSpeed, preferredSpeedUnit } from "@/hooks/useGpsSpeed";
import { formatSpeedLimit, useSpeedLimit } from "@/hooks/useSpeedLimit";
import { speakNav } from "@/lib/voice-nav";

/** How long we wait before treating an over-limit reading as
 *  sustained speeding (seconds). Avoids voice spam from a brief GPS
 *  noise spike that briefly overshoots the snapped limit. */
const SPEEDING_SUSTAINED_MS = 6000;
/** Minimum gap between repeat voice warnings within a single trip
 *  (ms). Without it the cue would fire every time the user dips
 *  below and back over the threshold during the same stretch. */
const SPEEDING_REPEAT_COOLDOWN_MS = 90_000;

interface Props {
  mps: number | null;
  /** Optional current location used to look up the road's posted speed
   *  limit via Overpass. When provided, a small shield appears next to
   *  the speed readout, turning red when the user is meaningfully over
   *  the limit. */
  loc?: { lat: number; lng: number } | null;
}

/** Small floating speed readout for active driving / cycling trips.
 *  Sits at the bottom-left, mirroring Maps' speed pill placement. Hides
 *  itself entirely while we have no reading. When `loc` is supplied,
 *  pairs with a US-style speed-limit shield snapped to the road. */
export default function SpeedChip({ mps, loc = null }: Props) {
  const unit = preferredSpeedUnit();
  const { limitKmh } = useSpeedLimit(loc ?? null, mps !== null);
  const limit = formatSpeedLimit(limitKmh, unit);
  const value = mps === null ? null : formatSpeed(mps, unit);

  // "Meaningfully over" = >5 mph / >8 km/h. Below that is rounding +
  // GPS noise. Above it the shield turns red so the user can react
  // without doing the conversion in their head.
  const speedingThreshold = unit === "mph" ? 5 : 8;
  const isSpeeding =
    value !== null && limit != null && Number(value) - Number(limit) >= speedingThreshold;

  // Sustained-speeding voice warning. We arm a timer the moment the
  // chip flips into the speeding state, fire a single TTS cue when
  // the user has been over for `SPEEDING_SUSTAINED_MS`, then enforce
  // a cooldown so the same warning doesn't repeat on every wobble.
  // Limit changes (entering a new zone) reset the cooldown so the
  // user always gets a fresh cue per posted-limit segment.
  const speedingArmedAtRef = useRef<number | null>(null);
  const lastWarnedAtRef = useRef<number>(0);
  const lastWarnedLimitRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isSpeeding || limit == null) {
      speedingArmedAtRef.current = null;
      return;
    }
    if (speedingArmedAtRef.current === null) {
      speedingArmedAtRef.current = Date.now();
    }
    const armedAt = speedingArmedAtRef.current;
    const limitChanged = lastWarnedLimitRef.current !== Number(limit);
    const cooledDown =
      Date.now() - lastWarnedAtRef.current > SPEEDING_REPEAT_COOLDOWN_MS;
    if (!limitChanged && !cooledDown) return;

    const t = window.setTimeout(() => {
      // Re-check the gate when the timer fires — the user may have
      // already eased off in the intervening seconds.
      if (speedingArmedAtRef.current !== armedAt) return;
      speakNav(`Speed limit ${limit}`, {
        priority: "alert",
        dedupeKey: `speeding-${limit}`,
        dedupeMs: SPEEDING_REPEAT_COOLDOWN_MS,
      });
      lastWarnedAtRef.current = Date.now();
      lastWarnedLimitRef.current = Number(limit);
    }, SPEEDING_SUSTAINED_MS);
    return () => window.clearTimeout(t);
  }, [isSpeeding, limit]);

  if (mps === null || value === null) return null;

  const label = unit === "mph" ? "mph" : "km/h";

  return (
    <div className="pp-speed-chip pointer-events-none absolute z-[1001] left-3 flex items-center gap-2">
      <div
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full backdrop-blur-xl shadow-2xl ${isSpeeding ? "speedchip-overspeed" : ""}`}
        style={{
          background: isSpeeding ? "rgba(127,29,29,0.92)" : "rgba(15,23,42,0.85)",
          border: `1px solid ${isSpeeding ? "rgba(239,68,68,0.6)" : "rgba(255,255,255,0.12)"}`,
          color: "#fff",
          fontVariantNumeric: "tabular-nums",
        }}
        role="status"
        aria-label={`Current speed ${value} ${label}${limit ? `, limit ${limit} ${label}` : ""}${isSpeeding ? ", over the limit" : ""}`}
      >
        <Gauge className="w-3.5 h-3.5 opacity-80" />
        <span className="text-base font-semibold leading-none">{value}</span>
        <span className="text-[10px] uppercase tracking-wider opacity-70">{label}</span>
      </div>

      {/* US-style speed-limit shield. Hidden when no posted limit is
          known for the snapped segment so we don't lie to the user. */}
      {limit && (
        <div
          className="flex flex-col items-center justify-center rounded-md px-2 py-0.5 shadow-2xl"
          style={{
            background: "#fff",
            color: "#000",
            border: "2px solid #000",
            minWidth: "2.25rem",
            fontVariantNumeric: "tabular-nums",
          }}
          aria-label={`Speed limit ${limit} ${label}`}
          title={`Posted limit ${limit} ${label}`}
        >
          <span className="text-[7px] font-bold uppercase tracking-wider leading-none mt-0.5">
            Limit
          </span>
          <span className="text-base font-extrabold leading-tight">{limit}</span>
        </div>
      )}
    </div>
  );
}
