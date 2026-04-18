"use client";

import { useState, useCallback } from "react";
import {
  Navigation,
  CornerUpRight,
  Share2,
  ExternalLink,
  Copy,
  Hash,
  Bookmark,
  Check,
  Home,
  Briefcase,
  Star,
  MapPin,
  type LucideIcon,
} from "lucide-react";
import { plusCode } from "@/lib/plus-code";
import {
  CATEGORY_LABELS,
  useSavedDestinations,
  type SavedCategory,
} from "@/hooks/useSavedDestinations";

interface Props {
  lat: number;
  lng: number;
  /** Display label used for share/save (falls back to "lat, lng"). */
  label?: string;
  /** When true, hides "Directions to" (e.g. you wouldn't navigate to your own dropped pin from itself). Default false. */
  hideDirections?: boolean;
  /** When set, the share link routes through `/share?incident=<id>&…` so
   *  social-link previews render a per-incident OG card. */
  incidentId?: string;
  /** Severity slug used for the OG card accent color. */
  incidentCategory?: string;
  /** ISO timestamp; rendered as "X min ago" on the OG card. */
  incidentTime?: string;
}

type ToastKind = "copied-coords" | "copied-pluscode" | "saved" | null;

/** Compact action-button row shared by SafetyScoreCard, IncidentDetail, and
 *  DroppedPinCard. Buttons: Directions to / from, Share, Open in Maps,
 *  Copy coordinates, Copy Plus Code, Save. Each is a 32px hit-target with
 *  ARIA labels and short-lived toasts for copy / save confirmations. */
const SAVE_OPTIONS: { id: SavedCategory; Icon: LucideIcon; color: string }[] = [
  { id: "home",     Icon: Home,      color: "#22c55e" },
  { id: "work",     Icon: Briefcase, color: "#3b82f6" },
  { id: "favorite", Icon: Star,      color: "#f59e0b" },
  { id: "custom",   Icon: MapPin,    color: "#94a3b8" },
];

export default function PlaceActions({
  lat,
  lng,
  label,
  hideDirections = false,
  incidentId,
  incidentCategory,
  incidentTime,
}: Props) {
  const [toast, setToast] = useState<ToastKind>(null);
  const [savePickerOpen, setSavePickerOpen] = useState(false);
  const { canSave, addDestination, destinations } = useSavedDestinations();

  const flashToast = useCallback((kind: ToastKind) => {
    setToast(kind);
    window.setTimeout(() => setToast((t) => (t === kind ? null : t)), 1600);
  }, []);

  const haptic = useCallback(() => {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try { navigator.vibrate?.(6); } catch { /* ignore */ }
    }
  }, []);

  const coordStr = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const displayLabel = label?.trim() || coordStr;

  const isSaved = destinations.some(
    (d) => Math.abs(d.lat - lat) < 1e-5 && Math.abs(d.lng - lng) < 1e-5
  );

  const onCopyCoords = useCallback(async () => {
    haptic();
    try {
      await navigator.clipboard.writeText(coordStr);
      flashToast("copied-coords");
    } catch { /* clipboard blocked — silently no-op */ }
  }, [coordStr, flashToast, haptic]);

  const onCopyPlusCode = useCallback(async () => {
    haptic();
    const code = plusCode(lat, lng);
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      flashToast("copied-pluscode");
    } catch { /* ignore */ }
  }, [lat, lng, flashToast, haptic]);

  const onShare = useCallback(async () => {
    haptic();
    // Share links route through `/share?...` so the unfurl card is rich
    // (incident accent color, location, "X min ago"). The /share page reads
    // these params, generates per-link OG metadata, then bounces real users
    // into the live app at `/?incident=<id>` or `/?lat=&lng=&zoom=`.
    const params = new URLSearchParams();
    if (incidentId) {
      params.set("incident", incidentId);
      if (incidentCategory) params.set("c", incidentCategory);
      if (incidentTime) params.set("time", incidentTime);
      if (label) params.set("loc", label);
      params.set("t", label || "Incident report");
    } else {
      params.set("lat", lat.toFixed(6));
      params.set("lng", lng.toFixed(6));
      params.set("zoom", "16");
      params.set("t", displayLabel);
      if (label) params.set("loc", label);
    }
    const url = `${window.location.origin}/share?${params.toString()}`;
    const shareText = incidentId
      ? `Incident near ${displayLabel}`
      : displayLabel;
    const shareData = { title: displayLabel, text: shareText, url };
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share(shareData);
        return;
      } catch { /* user cancelled — fall through to clipboard */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      flashToast("copied-coords");
    } catch { /* ignore */ }
  }, [lat, lng, displayLabel, incidentId, incidentCategory, incidentTime, label, flashToast, haptic]);

  const onOpenInMaps = useCallback(() => {
    haptic();
    const isApple = /iPhone|iPad|iPod|Mac/.test(navigator.userAgent);
    const url = isApple
      ? `https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(displayLabel)}`
      : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }, [lat, lng, displayLabel, haptic]);

  const onSaveAs = useCallback(async (cat: SavedCategory) => {
    haptic();
    if (!canSave) return;
    await addDestination(displayLabel, lat, lng, cat);
    setSavePickerOpen(false);
    flashToast("saved");
  }, [canSave, addDestination, displayLabel, lat, lng, flashToast, haptic]);

  const onDirectionsTo = useCallback(() => {
    haptic();
    const params = new URLSearchParams(window.location.search);
    params.set("dest_lat", lat.toFixed(6));
    params.set("dest_lng", lng.toFixed(6));
    params.set("dest_label", displayLabel);
    window.dispatchEvent(
      new CustomEvent("pp:plan-route", { detail: { mode: "to", lat, lng, label: displayLabel } })
    );
  }, [lat, lng, displayLabel, haptic]);

  const onDirectionsFrom = useCallback(() => {
    haptic();
    window.dispatchEvent(
      new CustomEvent("pp:plan-route", { detail: { mode: "from", lat, lng, label: displayLabel } })
    );
  }, [lat, lng, displayLabel, haptic]);

  const btn =
    "shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-colors active:scale-95";
  const btnStyle: React.CSSProperties = {
    background: "var(--panel-input-bg)",
    color: "var(--panel-text-secondary)",
    border: "1px solid var(--panel-border)",
  };

  const toastText =
    toast === "copied-coords"
      ? "Link copied"
      : toast === "copied-pluscode"
        ? "Plus Code copied"
        : toast === "saved"
          ? "Saved"
          : "";

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
        {!hideDirections && (
          <button
            type="button"
            onClick={onDirectionsTo}
            title="Directions to here"
            aria-label="Get directions to this location"
            className={btn}
            style={btnStyle}
          >
            <Navigation className="w-4 h-4" />
          </button>
        )}
        <button
          type="button"
          onClick={onDirectionsFrom}
          title="Directions from here"
          aria-label="Get directions from this location"
          className={btn}
          style={btnStyle}
        >
          <CornerUpRight className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onShare}
          title="Share"
          aria-label="Share this location"
          className={btn}
          style={btnStyle}
        >
          <Share2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onOpenInMaps}
          title="Open in Maps"
          aria-label="Open this location in Google or Apple Maps"
          className={btn}
          style={btnStyle}
        >
          <ExternalLink className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onCopyCoords}
          title={`Copy coordinates (${coordStr})`}
          aria-label="Copy coordinates to clipboard"
          className={btn}
          style={btnStyle}
        >
          <Copy className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onCopyPlusCode}
          title="Copy Plus Code"
          aria-label="Copy Plus Code to clipboard"
          className={btn}
          style={btnStyle}
        >
          <Hash className="w-4 h-4" />
        </button>
        {canSave && (
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setSavePickerOpen((v) => !v)}
              title={isSaved ? "Saved · choose category" : "Save place"}
              aria-label={isSaved ? "Already saved (change category)" : "Save this place"}
              aria-haspopup="menu"
              aria-expanded={savePickerOpen}
              className={btn}
              style={{
                ...btnStyle,
                color: isSaved ? "#3b82f6" : btnStyle.color,
                background: isSaved ? "rgba(59,130,246,0.12)" : btnStyle.background,
                borderColor: isSaved ? "rgba(59,130,246,0.35)" : (btnStyle.border as string),
              }}
            >
              {isSaved ? <Check className="w-4 h-4" /> : <Bookmark className="w-4 h-4" />}
            </button>
            {savePickerOpen && (
              <div
                role="menu"
                className="absolute bottom-full mb-2 right-0 z-10 rounded-lg shadow-2xl py-1 min-w-[140px]"
                style={{
                  background: "var(--panel-bg-secondary)",
                  border: "1px solid var(--panel-border)",
                }}
                onMouseLeave={() => setSavePickerOpen(false)}
              >
                <p
                  className="text-[9px] uppercase tracking-wider px-3 py-1"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  Save as
                </p>
                {SAVE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    role="menuitem"
                    type="button"
                    onClick={() => void onSaveAs(opt.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs"
                    style={{ color: "var(--panel-text-secondary)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <opt.Icon className="w-3.5 h-3.5" />
                    {CATEGORY_LABELS[opt.id]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="absolute -top-7 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-md text-[10px] font-medium pointer-events-none shadow-lg whitespace-nowrap"
          style={{
            background: "rgba(15, 23, 42, 0.92)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {toastText}
        </div>
      )}
    </div>
  );
}
