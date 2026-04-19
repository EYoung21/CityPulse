"use client";

import { useEffect, useState } from "react";
import { MapPin, X, Hash, Ban, Check } from "lucide-react";
import PlaceActions from "@/components/PlaceActions";
import NearbyPois from "@/components/NearbyPois";
import QuickSavePlace from "@/components/QuickSavePlace";
import ReportPinForm from "@/components/ReportPinForm";
import { reverseGeocode } from "@/lib/search";
import { plusCode } from "@/lib/plus-code";
import { addAvoidArea } from "@/lib/avoid-areas";

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
  // Local "added" feedback state — shows a Check icon for ~2s after
  // the user adds this pin to their avoid-areas blocklist.
  const [avoidAdded, setAvoidAdded] = useState(false);

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

        {/* Inline quick-save form. The bookmark icon in PlaceActions
            persists with the auto-generated label only; QuickSavePlace
            adds name editing + per-list assignment so users can drop a
            pin directly into "Coffee shops" without opening the
            sidebar. */}
        <QuickSavePlace lat={lat} lng={lng} suggestedName={address ?? undefined} />

        <button
          type="button"
          onClick={() => {
            // Use a default radius of 200m — covers a typical city
            // block. Users can fine-tune it from the Manage panel.
            addAvoidArea({ lat, lng, radiusM: 200, label: address ?? undefined });
            setAvoidAdded(true);
            setTimeout(() => setAvoidAdded(false), 2200);
          }}
          className="w-full inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
          style={{
            background: avoidAdded ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.10)",
            color: avoidAdded ? "#22c55e" : "#ef4444",
            border: `1px solid ${avoidAdded ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.30)"}`,
          }}
          aria-pressed={avoidAdded}
        >
          {avoidAdded ? <Check className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
          {avoidAdded ? "Added — routing will avoid this area" : "Avoid this area in routing"}
        </button>

        {/* Crowdsourced report. Renders as a single "Report what you
            see" button that expands into a category picker + note
            field. Only signed-in (non-anonymous) users can post; the
            form handles the gating + error surface itself. */}
        <ReportPinForm lat={lat} lng={lng} />

        <div className="h-px" style={{ background: "var(--panel-border)" }} />

        <NearbyPois lat={lat} lng={lng} />

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
