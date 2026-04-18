"use client";

import { useEffect, useState } from "react";
import { MapPin, X, Hash } from "lucide-react";
import PlaceActions from "@/components/PlaceActions";
import { reverseGeocode } from "@/lib/search";
import { plusCode } from "@/lib/plus-code";

interface Props {
  lat: number;
  lng: number;
  onClose: () => void;
}

/** Address-focused card shown on long-press. Mirrors the style of
 *  SafetyScoreCard but emphasizes location identifiers (address, lat/lng,
 *  Plus Code) and shares the same PlaceActions row. */
export default function DroppedPinCard({ lat, lng, onClose }: Props) {
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setAddress(null);
    reverseGeocode(lat, lng)
      .then((label) => {
        if (!cancelled) setAddress(label);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  const code = plusCode(lat, lng);
  const title = address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  return (
    <div
      className="rounded-xl overflow-hidden backdrop-blur-xl shadow-2xl"
      style={{ background: "var(--panel-bg)", border: "1px solid var(--panel-border)" }}
    >
      <div className="bg-gradient-to-r from-red-500/15 to-rose-500/5 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-red-500" />
            <span className="text-xs font-bold uppercase tracking-wider text-red-500">
              Dropped Pin
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 -m-1"
            style={{ color: "var(--panel-text-muted)" }}
            aria-label="Remove dropped pin"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-3">
        <div>
          <h3
            className="font-semibold text-sm leading-snug truncate"
            style={{ color: "var(--panel-text)" }}
            title={title}
          >
            {loading ? (
              <span style={{ color: "var(--panel-text-muted)" }}>Looking up address…</span>
            ) : (
              title
            )}
          </h3>
          <div
            className="mt-1 flex items-center gap-2 text-[11px] font-mono"
            style={{ color: "var(--panel-text-secondary)" }}
          >
            <span>{lat.toFixed(5)}, {lng.toFixed(5)}</span>
            {code && (
              <>
                <span style={{ color: "var(--panel-border)" }}>·</span>
                <span className="flex items-center gap-1" title="Plus Code">
                  <Hash className="w-3 h-3" />
                  {code}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="h-px" style={{ background: "var(--panel-border)" }} />

        <PlaceActions lat={lat} lng={lng} label={address ?? undefined} />

        <p
          className="text-[9px] text-center pt-0.5"
          style={{ color: "var(--panel-text-muted)" }}
        >
          Long-press anywhere on the map to drop a pin · Tap for safety score
        </p>
      </div>
    </div>
  );
}
