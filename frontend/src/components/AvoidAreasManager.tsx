"use client";

import { useEffect, useState } from "react";
import { Ban, Trash2, MapPin } from "lucide-react";
import {
  loadAvoidAreas,
  removeAvoidArea,
  clearAvoidAreas,
  updateAvoidArea,
  subscribeAvoidAreas,
  type AvoidArea,
} from "@/lib/avoid-areas";

interface Props {
  /** Optional callback fired when a row is tapped — host can fly the
   *  map to the area so the user can confirm what they're managing. */
  onJump?: (area: AvoidArea) => void;
}

/** Inline listing of the user's personal avoid-area blocklist. Mounted
 *  inside the layers menu so it sits next to the toggle that controls
 *  the on-map overlay. Each row exposes a radius slider (25–1500 m)
 *  and a delete button. We deliberately don't try to be a full picker
 *  here — adding new areas happens via the dropped-pin sticky card. */
export default function AvoidAreasManager({ onJump }: Props) {
  const [areas, setAreas] = useState<AvoidArea[]>(loadAvoidAreas);

  useEffect(() => {
    return subscribeAvoidAreas(setAreas);
  }, []);

  if (areas.length === 0) {
    return (
      <p
        className="text-[10px] leading-snug px-2 pb-1.5"
        style={{ color: "var(--panel-text-muted)" }}
      >
        Long-press anywhere on the map and tap{" "}
        <span className="font-semibold inline-flex items-center gap-0.5">
          <Ban className="w-2.5 h-2.5" /> Avoid this area
        </span>{" "}
        to add a personal blocklist zone.
      </p>
    );
  }

  return (
    <div className="px-1.5 pb-1.5 space-y-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
          {areas.length} {areas.length === 1 ? "area" : "areas"} avoided in routing
        </span>
        <button
          type="button"
          onClick={() => clearAvoidAreas()}
          className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{ color: "#ef4444" }}
          title="Remove all avoided areas"
        >
          Clear all
        </button>
      </div>
      <div className="max-h-44 overflow-y-auto space-y-1">
        {areas.map((a) => (
          <div
            key={a.id}
            className="rounded-lg p-1.5 text-[11px]"
            style={{
              background: "var(--panel-input-bg)",
              border: "1px solid var(--panel-border)",
            }}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onJump?.(a)}
                className="flex-1 min-w-0 text-left inline-flex items-center gap-1.5"
                style={{ color: "var(--panel-text)" }}
                title="Jump to this area on the map"
              >
                <MapPin className="w-3 h-3 shrink-0" style={{ color: "#ef4444" }} />
                <span className="truncate">
                  {a.label || `${a.lat.toFixed(4)}, ${a.lng.toFixed(4)}`}
                </span>
              </button>
              <button
                type="button"
                onClick={() => removeAvoidArea(a.id)}
                className="shrink-0 p-1 rounded"
                style={{ color: "var(--panel-text-muted)" }}
                aria-label="Remove this avoid area"
                title="Remove"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range"
                min={25}
                max={1500}
                step={25}
                value={a.radiusM}
                onChange={(e) => updateAvoidArea(a.id, { radiusM: Number(e.target.value) })}
                className="flex-1 accent-red-500"
                aria-label="Avoid radius in meters"
              />
              <span
                className="text-[10px] tabular-nums w-12 text-right"
                style={{ color: "var(--panel-text-secondary)" }}
              >
                {a.radiusM} m
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
