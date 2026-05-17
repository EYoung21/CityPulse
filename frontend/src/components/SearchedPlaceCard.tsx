"use client";

/** Compact "you tapped this place" card.
 *
 *  Shown inline by SearchSidebar when the user taps a search result.
 *  Mirrors Google Maps' "place card" pattern, scoped down to the
 *  three actions that actually work with the data we have on hand:
 *  Directions, Save, and Share. No photos, hours, or phone — OSM
 *  carries those tags inconsistently and an empty card row feels
 *  worse than no card at all.
 *
 *  The Directions button is the visual hero (full-width, blue)
 *  because that's what 90% of taps want; Save and Share are
 *  secondary icon buttons. */

import { useEffect, useMemo, useState } from "react";
import { Navigation, Bookmark, Share2, X as XIcon, MapPin, Check } from "lucide-react";
import { reverseGeocode } from "@/lib/search";
import { share as nativeShare } from "@/lib/native";
import { useSavedDestinations } from "@/hooks/useSavedDestinations";
import { placesMatch } from "@/lib/saved-place-match";

export interface SelectedPlace {
  name: string;
  lat: number;
  lng: number;
}

interface Props {
  place: SelectedPlace;
  /** Fired when the user taps "Directions" — parent opens the
   *  routing panel with this place pre-filled as the destination. */
  onDirections: (place: SelectedPlace) => void;
  onClose: () => void;
}

export default function SearchedPlaceCard({ place, onDirections, onClose }: Props) {
  const [address, setAddress] = useState<string | null>(null);
  const [addressLoading, setAddressLoading] = useState(true);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [shareState, setShareState] = useState<"idle" | "sharing" | "done">("idle");
  const { addDestination, destinations } = useSavedDestinations();

  const alreadySaved = useMemo(
    () => destinations.some((d) => placesMatch(d.lat, d.lng, place.lat, place.lng)),
    [destinations, place.lat, place.lng]
  );

  // Reverse-geocode for the subtitle — same pattern as LocationPeekCard.
  // Single shot; on failure we silently fall back to coords.
  useEffect(() => {
    let cancelled = false;
    setAddress(null);
    setAddressLoading(true);
    reverseGeocode(place.lat, place.lng)
      .then((label) => {
        if (!cancelled) setAddress(label);
      })
      .catch(() => {
        /* fall through to coords */
      })
      .finally(() => {
        if (!cancelled) setAddressLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [place.lat, place.lng]);

  const handleSave = async () => {
    if (saveState === "saving" || alreadySaved) return;
    setSaveState("saving");
    try {
      await addDestination(place.name, place.lat, place.lng, "favorite");
      setSaveState("saved");
    } catch {
      // Most common failure: the free-tier save cap. Show a brief
      // error state; the user can re-tap to retry or just close.
      setSaveState("error");
      window.setTimeout(() => setSaveState("idle"), 2500);
    }
  };

  const handleShare = async () => {
    if (shareState === "sharing") return;
    setShareState("sharing");
    try {
      const url = `${window.location.origin}/share?lat=${place.lat}&lng=${place.lng}&loc=${encodeURIComponent(place.name)}`;
      await nativeShare({
        title: place.name,
        text: place.name,
        url,
        dialogTitle: "Share via",
      });
      setShareState("done");
      window.setTimeout(() => setShareState("idle"), 1500);
    } catch {
      setShareState("idle");
    }
  };

  const subtitle = address
    ? address
    : addressLoading
      ? "Looking up address…"
      : `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`;

  return (
    <div className="mx-3 mb-3 mt-1 rounded-xl overflow-hidden"
      style={{
        background: "var(--panel-bg)",
        border: "1px solid var(--panel-border)",
      }}
    >
      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            <h3
              className="text-sm font-semibold leading-snug truncate"
              style={{ color: "var(--panel-text)" }}
            >
              {place.name}
            </h3>
            <p
              className="mt-0.5 text-[11px] flex items-start gap-1.5"
              style={{ color: "var(--panel-text-muted, #9ca3af)" }}
            >
              <MapPin className="w-3 h-3 shrink-0 mt-px" aria-hidden />
              <span className="truncate">{subtitle}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close place card"
            className="p-1 -m-1 rounded shrink-0"
            style={{ color: "var(--panel-text-muted, #9ca3af)" }}
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Primary CTA — Directions takes the full row so it's the
            visual hero. Save and Share are secondary, icon-only,
            sit on the right. */}
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={() => onDirections(place)}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full text-sm font-semibold transition-colors"
            style={{
              background: "#3b82f6",
              color: "white",
            }}
          >
            <Navigation className="w-4 h-4" />
            Directions
          </button>

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saveState === "saving"}
            aria-label={alreadySaved || saveState === "saved" ? "Already saved" : "Save place"}
            title={alreadySaved || saveState === "saved" ? "Already saved" : "Save place"}
            className="shrink-0 w-10 h-10 inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-50"
            style={{
              background: "var(--panel-input-bg, rgba(255,255,255,0.05))",
              border: "1px solid var(--panel-input-border, rgba(255,255,255,0.08))",
              color:
                alreadySaved || saveState === "saved"
                  ? "#a855f7"
                  : saveState === "error"
                    ? "#ef4444"
                    : "var(--panel-text)",
            }}
          >
            {saveState === "saved" || alreadySaved ? (
              <Bookmark className="w-4 h-4" fill="currentColor" />
            ) : (
              <Bookmark className="w-4 h-4" />
            )}
          </button>

          <button
            type="button"
            onClick={() => void handleShare()}
            disabled={shareState === "sharing"}
            aria-label="Share place"
            title="Share place"
            className="shrink-0 w-10 h-10 inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-50"
            style={{
              background: "var(--panel-input-bg, rgba(255,255,255,0.05))",
              border: "1px solid var(--panel-input-border, rgba(255,255,255,0.08))",
              color: shareState === "done" ? "#22c55e" : "var(--panel-text)",
            }}
          >
            {shareState === "done" ? (
              <Check className="w-4 h-4" />
            ) : (
              <Share2 className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
