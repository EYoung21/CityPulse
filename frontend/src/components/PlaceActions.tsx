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
  Home,
  Briefcase,
  Star,
  MapPin,
  Car,
  Plus,
  Phone,
  Globe,
  type LucideIcon,
} from "lucide-react";
import { plusCode } from "@/lib/plus-code";
import { share as nativeShare, haptic as nativeHaptic } from "@/lib/native";
import { setParkedPin } from "@/lib/parked-pin";
import { useRouteState } from "@/lib/route-state";
import {
  CATEGORY_LABELS,
  SavedPlaceLimitError,
  useSavedDestinations,
  type SavedCategory,
} from "@/hooks/useSavedDestinations";
import { requestUpgrade } from "@/lib/upgrade";

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
  /** Optional contact info — surfaced as Call / Site CTA buttons at
   *  the head of the action row when present. Populated by callers
   *  who have OSM tag data on hand (SafetyScoreCard could opt in
   *  if we ever want phone CTAs on the tap-pulse card via a small
   *  Overpass lookup). Both are optional
   *  and independent — websites without phones, phones without
   *  websites, both, or neither all render correctly. */
  phone?: string;
  website?: string;
}

type ToastKind = "copied-coords" | "copied-pluscode" | "saved" | "removed" | "parked" | "added-stop" | null;

/** Compact action-button row shared by SafetyScoreCard and IncidentDetail.
 *  Buttons: Directions to / from, Share, Open in Maps, Copy coordinates,
 *  Copy Plus Code, Save. Each is a 32px hit-target with ARIA labels and
 *  short-lived toasts for copy / save confirmations. */
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
  phone,
  website,
}: Props) {
  const [toast, setToast] = useState<ToastKind>(null);
  const [savePickerOpen, setSavePickerOpen] = useState(false);
  const { canSave, addDestination, removeDestination, destinations } = useSavedDestinations();
  // We only show "Add as stop" when the user is mid-route-planning or
  // mid-trip — otherwise the button is confusing for users who haven't
  // opened the directions panel yet. Source of truth is the global
  // route-state pubsub published by SearchSidebar.
  const routeState = useRouteState();
  const canAddStop =
    routeState.view === "directions" || routeState.tripActive;

  const flashToast = useCallback((kind: ToastKind) => {
    setToast(kind);
    window.setTimeout(() => setToast((t) => (t === kind ? null : t)), 1600);
  }, []);

  const haptic = useCallback(() => {
    void nativeHaptic("light");
  }, []);

  const coordStr = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const displayLabel = label?.trim() || coordStr;

  const isSaved = destinations.some(
    (d) => Math.abs(d.lat - lat) < 1e-5 && Math.abs(d.lng - lng) < 1e-5
  );
  const savedMatch = destinations.find(
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
    const hasNativeOrWebShare =
      typeof navigator !== "undefined" && "share" in navigator;
    // Native sheet on iOS/Android; navigator.share on web; clipboard fallback.
    await nativeShare({
      title: displayLabel,
      text: shareText,
      url,
      dialogTitle: "Share via",
    });
    if (!hasNativeOrWebShare) {
      flashToast("copied-coords");
    }
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
    try {
      await addDestination(displayLabel, lat, lng, cat);
      setSavePickerOpen(false);
      flashToast("saved");
    } catch (e) {
      if (e instanceof SavedPlaceLimitError) {
        setSavePickerOpen(false);
        requestUpgrade(e.feature);
      } else {
        throw e;
      }
    }
  }, [canSave, addDestination, displayLabel, lat, lng, flashToast, haptic]);

  const onRemoveSaved = useCallback(async () => {
    if (!savedMatch) return;
    haptic();
    try {
      await removeDestination(savedMatch.id);
      setSavePickerOpen(false);
      flashToast("removed");
    } catch {
      /* ignore */
    }
  }, [savedMatch, removeDestination, flashToast, haptic]);

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

  const onParkHere = useCallback(() => {
    haptic();
    setParkedPin({ lat, lng, label: displayLabel });
    flashToast("parked");
  }, [lat, lng, displayLabel, flashToast, haptic]);

  const onDirectionsFrom = useCallback(() => {
    haptic();
    window.dispatchEvent(
      new CustomEvent("pp:plan-route", { detail: { mode: "from", lat, lng, label: displayLabel } })
    );
  }, [lat, lng, displayLabel, haptic]);

  /** Insert this place as an intermediate stop on the active route.
   *  SearchSidebar listens for `pp:add-stop` and appends the waypoint;
   *  DirectionsPanel will recompute the polyline on its next debounced
   *  pass. Same event AlongRoutePanel uses, so both code paths share
   *  one handler upstream. */
  const onAddAsStop = useCallback(() => {
    haptic();
    window.dispatchEvent(
      new CustomEvent("pp:add-stop", {
        detail: { name: displayLabel, lat, lng },
      })
    );
    flashToast("added-stop");
  }, [lat, lng, displayLabel, flashToast, haptic]);

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
          : toast === "removed"
            ? "Removed from saved"
          : toast === "parked"
            ? "Parked here"
            : toast === "added-stop"
              ? "Added as stop"
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
        {phone && (
          <a
            href={`tel:${phone.replace(/[^0-9+]/g, "")}`}
            onClick={haptic}
            title={`Call ${phone}`}
            aria-label={`Call ${phone}`}
            className={btn}
            style={{
              ...btnStyle,
              color: "#22c55e",
              background: "rgba(34,197,94,0.10)",
              borderColor: "rgba(34,197,94,0.30)",
            }}
          >
            <Phone className="w-4 h-4" />
          </a>
        )}
        {website && (
          <a
            href={website}
            target="_blank"
            rel="noopener noreferrer"
            onClick={haptic}
            title={`Open website (${website})`}
            aria-label="Open website"
            className={btn}
            style={{
              ...btnStyle,
              color: "#3b82f6",
              background: "rgba(59,130,246,0.10)",
              borderColor: "rgba(59,130,246,0.30)",
            }}
          >
            <Globe className="w-4 h-4" />
          </a>
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
        {canAddStop && (
          <button
            type="button"
            onClick={onAddAsStop}
            title="Add as stop on current route"
            aria-label="Add this location as a stop on the current route"
            className={btn}
            style={{
              ...btnStyle,
              color: "#3b82f6",
              background: "rgba(59,130,246,0.10)",
              borderColor: "rgba(59,130,246,0.30)",
            }}
          >
            <Plus className="w-4 h-4" />
          </button>
        )}
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
        <button
          type="button"
          onClick={onParkHere}
          title="Mark as parked here (24h reminder)"
          aria-label="Mark this location as where you parked"
          className={btn}
          style={btnStyle}
        >
          <Car className="w-4 h-4" />
        </button>
        {canSave && (
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setSavePickerOpen((v) => !v)}
              title={isSaved ? "Saved · tap to change or remove" : "Save place"}
              aria-label={isSaved ? "Saved place options" : "Save this place"}
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
              <Bookmark
                className="w-4 h-4"
                {...(isSaved ? { fill: "currentColor" } : {})}
              />
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
                {isSaved && (
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => void onRemoveSaved()}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs"
                    style={{ color: "#f87171" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    Remove from saved
                  </button>
                )}
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
