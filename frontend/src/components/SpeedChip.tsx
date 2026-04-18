"use client";

import { Gauge } from "lucide-react";
import { formatSpeed, preferredSpeedUnit } from "@/hooks/useGpsSpeed";

interface Props {
  mps: number | null;
}

/** Small floating speed readout for active driving / cycling trips.
 *  Sits at the bottom-left, mirroring Maps' speed pill placement. Hides
 *  itself entirely while we have no reading. */
export default function SpeedChip({ mps }: Props) {
  if (mps === null) return null;
  const unit = preferredSpeedUnit();
  const value = formatSpeed(mps, unit);
  const label = unit === "mph" ? "mph" : "km/h";
  return (
    <div
      className="pointer-events-none absolute z-[1001] left-3 flex items-center gap-2 px-3 py-1.5 rounded-full backdrop-blur-xl shadow-2xl"
      style={{
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)",
        background: "rgba(15,23,42,0.85)",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "#fff",
        fontVariantNumeric: "tabular-nums",
      }}
      role="status"
      aria-label={`Current speed ${value} ${label}`}
    >
      <Gauge className="w-3.5 h-3.5 opacity-80" />
      <span className="text-base font-semibold leading-none">{value}</span>
      <span className="text-[10px] uppercase tracking-wider opacity-70">{label}</span>
    </div>
  );
}
