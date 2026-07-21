"use client";

/** Compact "you tapped this place" card.
 *
 *  Shown inline by SearchSidebar when the user taps a search result.
 *  Mirrors Google Maps' "place card" pattern as closely as we can
 *  manage without a paid Places API:
 *
 *    - title + bookmark/share/close in the header row
 *    - category ("Art museum"), open/closed status with hours, drive
 *      ETA from the user's current location, and accessibility badge
 *      pulled from free OSM tags via Overpass
 *    - a four-button action row (Directions / Start / Ask / Site or
 *      Call) instead of the single big Directions CTA
 *
 *  Everything degrades gracefully — if Overpass returns nothing or
 *  ORS fails, the missing rows simply don't render. The card never
 *  needs API keys or env config the user has to set up; ORS uses
 *  the same baked-in default key the rest of the app uses, and OSM
 *  Overpass / Nominatim are public endpoints. */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Navigation,
  Bookmark,
  Share2,
  X as XIcon,
  MapPin,
  Check,
  Play,
  Sparkles,
  Globe,
  Phone,
  Accessibility,
  Car,
  Loader2,
} from "lucide-react";
import { normalizeHttpUrl } from "@/lib/safe-url";
import { reverseGeocode } from "@/lib/search";
import { share as nativeShare } from "@/lib/native";
import { useSavedDestinations } from "@/hooks/useSavedDestinations";
import { placesMatch } from "@/lib/saved-place-match";
import { fetchPlaceAtPoint, type PlaceAtPoint } from "@/lib/overpass";
import { evaluateOpeningHours, formatOpeningBadge } from "@/lib/opening-hours";
import { getRoute } from "@/lib/routing";
import { openAskPulseTab } from "@/lib/open-ask-pulse";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

const ORS_API_KEY =
  process.env.NEXT_PUBLIC_ORS_KEY || "5b3ce3597851110001cf6248a1b2c3d4e5f6a7b8";

export interface SelectedPlace {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  category?: string;
  categories?: string[];
  phone?: string;
  website?: string;
  openingHours?: unknown;
  provider?: string;
  entityId?: string;
}

type RemotePlaceDetails = {
  name?: string;
  address?: string;
  category?: string;
  categories?: string[];
  phone?: string;
  website?: string;
  openingHours?: unknown;
};

function normalizeRemotePlaceDetails(value: unknown): RemotePlaceDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = (field: unknown, max = 500) =>
    typeof field === "string" && field.trim() ? field.trim().slice(0, max) : undefined;
  const categories = Array.isArray(row.categories)
    ? row.categories.flatMap((category) => {
        const clean = text(category, 100);
        return clean ? [clean] : [];
      }).slice(0, 50)
    : undefined;
  return {
    name: text(row.name),
    address: text(row.address, 1_000),
    category: text(row.category, 100),
    categories,
    phone: text(row.phone, 100),
    website: normalizeHttpUrl(row.website) ?? undefined,
    openingHours: row.openingHours,
  };
}

function tomTomOpeningLabel(openingHours: unknown): string | null {
  if (!openingHours || typeof openingHours !== "object") return null;
  const record = openingHours as Record<string, unknown>;
  const openNow = record.openNow ?? record.isOpen ?? record.open;
  if (openNow === true) return "Open now";
  if (openNow === false) return "Closed now";
  return "Hours available";
}

interface Props {
  place: SelectedPlace;
  /** Current GPS / fallback origin. Used to compute the drive-ETA pill
   *  ("🚗 35 min") and to skip the ETA row entirely when we don't yet
   *  have a position to route from. */
  userPos?: { lat: number; lng: number } | null;
  /** Fired when the user taps "Directions" — parent opens the routing
   *  panel with this place pre-filled as the destination. */
  onDirections: (place: SelectedPlace) => void;
  /** Optional one-tap "Start" — parent seeds the destination and kicks
   *  off live navigation without the user round-tripping through the
   *  directions panel. Matches Google Maps' Start button. */
  onStart?: (place: SelectedPlace) => void;
  onClose: () => void;
}

export default function SearchedPlaceCard({
  place,
  userPos,
  onDirections,
  onStart,
  onClose,
}: Props) {
  const placeKey = `${place.lat.toFixed(6)},${place.lng.toFixed(6)}`;
  const [addressResult, setAddressResult] = useState<{
    key: string;
    address: string | null;
    loading: boolean;
  } | null>(null);
  const [details, setDetails] = useState<{ key: string; data: PlaceAtPoint | null } | null>(null);
  const [remoteDetails, setRemoteDetails] = useState<{
    key: string;
    data: RemotePlaceDetails | null;
  } | null>(null);
  const [eta, setEta] = useState<{ key: string; minutes: number | null; loading: boolean }>({
    key: "",
    minutes: null,
    loading: false,
  });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [shareState, setShareState] = useState<"idle" | "sharing" | "done">("idle");
  const { addDestination, removeDestination, destinations } = useSavedDestinations();
  const etaAbortRef = useRef<AbortController | null>(null);

  const savedDestId = useMemo(
    () =>
      destinations.find((d) => placesMatch(d.lat, d.lng, place.lat, place.lng))?.id ?? null,
    [destinations, place.lat, place.lng]
  );
  const alreadySaved = savedDestId !== null;

  // Reverse-geocode for the address subtitle — same pattern as
  // LocationPeekCard. Single shot; on failure we silently fall back
  // to the coords so the card never shows a blank row.
  useEffect(() => {
    let cancelled = false;
    reverseGeocode(place.lat, place.lng)
      .then((label) => {
        if (!cancelled) setAddressResult({ key: placeKey, address: label, loading: false });
      })
      .catch(() => {
        if (!cancelled) setAddressResult({ key: placeKey, address: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [place.lat, place.lng, placeKey]);

  // Overpass tag lookup — gets us "kind", opening_hours, phone,
  // website, wheelchair without a paid Places API. 80m radius is
  // generous enough that a Nominatim centroid for a building still
  // resolves to the nearest tagged amenity node inside it.
  useEffect(() => {
    let cancelled = false;
    void fetchPlaceAtPoint(place.lat, place.lng, 80)
      .then((data) => {
        if (!cancelled) setDetails({ key: placeKey, data });
      })
      .catch(() => {
        if (!cancelled) setDetails({ key: placeKey, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [place.lat, place.lng, placeKey]);

  useEffect(() => {
    let cancelled = false;
    if (!place.entityId) {
      void Promise.resolve().then(() => {
        if (!cancelled) setRemoteDetails({ key: placeKey, data: null });
      });
      return () => {
        cancelled = true;
      };
    }
    const params = new URLSearchParams({ entityId: place.entityId });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    void fetch(`/api/place-details?${params}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const raw = await readBoundedJsonResponse(res, 512 * 1024);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        return normalizeRemotePlaceDetails((raw as Record<string, unknown>).place);
      })
      .then((data) => {
        if (!cancelled) setRemoteDetails({ key: placeKey, data });
      })
      .catch(() => {
        if (!cancelled) setRemoteDetails({ key: placeKey, data: null });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [place.entityId, placeKey]);

  // Drive ETA from the user's current position. Mirrors the "🚗 35 min"
  // pill in Google Maps' place card. Skipped (gracefully) when we don't
  // have a position yet, when ORS is unreachable, or when the request
  // is superseded by the user tapping a new place — that's what the
  // AbortController is for.
  useEffect(() => {
    etaAbortRef.current?.abort();
    // We do everything inside an async IIFE so all setEta() writes
    // live in a promise tick, not synchronously inside the effect
    // body (react-hooks/set-state-in-effect would otherwise flag a
    // cascading-render risk).
    let cancelled = false;
    const controller = userPos ? new AbortController() : null;
    if (controller) etaAbortRef.current = controller;
    void (async () => {
      if (!userPos) {
        if (!cancelled) setEta({ key: placeKey, minutes: null, loading: false });
        return;
      }
      if (!cancelled) setEta({ key: placeKey, minutes: null, loading: true });
      try {
        const route = await getRoute(
          ORS_API_KEY,
          "driving-car",
          [userPos.lat, userPos.lng],
          [place.lat, place.lng]
        );
        if (cancelled || controller!.signal.aborted) return;
        setEta({
          key: placeKey,
          minutes: route ? Math.max(1, Math.ceil(route.durationMin)) : null,
          loading: false,
        });
      } catch {
        if (!cancelled && !controller!.signal.aborted) {
          setEta({ key: placeKey, minutes: null, loading: false });
        }
      }
    })();
    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [userPos, place.lat, place.lng, placeKey]);

  const handleSave = async () => {
    if (saveState === "saving") return;
    setSaveState("saving");
    try {
      if (savedDestId) {
        // Already saved → un-save. Drop back to the idle outline-
        // bookmark state so the user gets the same visual feedback
        // they would from the saved-places sidebar's trash button.
        await removeDestination(savedDestId);
        setSaveState("idle");
      } else {
        await addDestination(place.name, place.lat, place.lng, "favorite");
        setSaveState("saved");
      }
    } catch {
      // Most common failure on add: the free-tier save cap. On
      // remove the realistic failure is a transient network blip.
      // Either way we flash an error tint and let the user retry.
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

  const tomtomDetails = remoteDetails?.key === placeKey ? remoteDetails.data : null;
  const address =
    place.address ??
    tomtomDetails?.address ??
    (addressResult?.key === placeKey ? addressResult.address : null);
  const addressLoading = addressResult?.key !== placeKey || addressResult.loading;
  const placeDetails = details?.key === placeKey ? details.data : null;
  const categoryLabel =
    placeDetails?.kind ??
    place.category ??
    tomtomDetails?.category ??
    place.categories?.[0] ??
    tomtomDetails?.categories?.[0] ??
    null;

  const subtitle = address
    ? address
    : addressLoading
      ? "Looking up address…"
      : `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`;

  const openingStatus = useMemo(
    () => (placeDetails?.openingHours ? evaluateOpeningHours(placeDetails.openingHours) : null),
    [placeDetails]
  );
  const openingBadge = useMemo(() => formatOpeningBadge(openingStatus), [openingStatus]);
  const tomtomHoursLabel = useMemo(
    () => tomTomOpeningLabel(place.openingHours ?? tomtomDetails?.openingHours),
    [place.openingHours, tomtomDetails?.openingHours]
  );
  const openingLabel = openingBadge?.label ?? tomtomHoursLabel;

  // Map the opening-hours tone to a color that's legible in both
  // dark and light theme. Stick to Tailwind tone hexes to match the
  // rest of the UI's status accents.
  const openingColor =
    openingBadge?.tone === "open"
      ? "#22c55e"
      : openingBadge?.tone === "closing-soon"
        ? "#f59e0b"
        : openingBadge?.tone === "always"
          ? "#22c55e"
          : openingBadge?.tone === "closed"
            ? "#ef4444"
            : tomtomHoursLabel
              ? "var(--panel-text-secondary)"
              : "var(--panel-text-secondary)";

  // The fourth action button is contextual: prefer Website (rare and
  // valuable enough to expose at the top), else Call (also rare but
  // common enough on US POIs). If neither exists we hide that slot
  // rather than render a dead button.
  const websiteUrl = normalizeHttpUrl(placeDetails?.website ?? tomtomDetails?.website ?? place.website);
  const phoneNumber = placeDetails?.phone ?? tomtomDetails?.phone ?? place.phone ?? null;

  const etaLabel =
    eta.key === placeKey && eta.minutes != null
      ? `${eta.minutes} min`
      : eta.key === placeKey && eta.loading
        ? null
        : null;

  return (
    <div
      className="mx-3 mb-3 mt-1 rounded-xl overflow-hidden"
      style={{
        background: "var(--panel-bg)",
        border: "1px solid var(--panel-border)",
      }}
    >
      <div className="p-3.5">
        {/* Header: title on the left, Save / Share / Close icon row on
            the right — mirrors Google Maps' place card chrome. */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            <h3
              className="text-base font-semibold leading-snug truncate"
              style={{ color: "var(--panel-text)" }}
            >
              {place.name}
            </h3>
            {/* Category / accessibility / drive-ETA chip line — the
                Google Maps "Art museum · 35 min" row, assembled from
                whatever metadata we managed to pull. */}
            {(categoryLabel || etaLabel || eta.loading || placeDetails?.wheelchair) && (
              <div
                className="mt-1 flex items-center flex-wrap gap-x-2 gap-y-0.5 text-[12px]"
                style={{ color: "var(--panel-text-secondary)" }}
              >
                {(etaLabel || eta.loading) && (
                  <span
                    className="inline-flex items-center gap-1"
                    title="Estimated driving time from your location"
                  >
                    <Car className="w-3.5 h-3.5" aria-hidden />
                    {etaLabel ?? <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
                    {etaLabel ? <span className="sr-only"> driving</span> : null}
                  </span>
                )}
                {(etaLabel || eta.loading) && categoryLabel ? (
                  <span aria-hidden style={{ color: "var(--panel-text-muted)" }}>·</span>
                ) : null}
                {categoryLabel && <span className="truncate">{categoryLabel}</span>}
                {placeDetails?.wheelchair === "yes" && (
                  <>
                    <span aria-hidden style={{ color: "var(--panel-text-muted)" }}>·</span>
                    <span
                      className="inline-flex items-center gap-1"
                      title="Wheelchair accessible (OSM)"
                    >
                      <Accessibility className="w-3.5 h-3.5" aria-hidden />
                      <span className="sr-only">Wheelchair accessible</span>
                    </span>
                  </>
                )}
              </div>
            )}
            {openingLabel && (
              <p
                className="mt-1 text-[12px] font-medium"
                style={{ color: openingColor }}
              >
                {openingLabel}
              </p>
            )}
            <p
              className="mt-1 text-[11px] flex items-start gap-1.5"
              style={{ color: "var(--panel-text-muted, #9ca3af)" }}
            >
              <MapPin className="w-3 h-3 shrink-0 mt-px" aria-hidden />
              <span className="truncate">{subtitle}</span>
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saveState === "saving"}
              aria-label={alreadySaved || saveState === "saved" ? "Remove from saved" : "Save place"}
              title={alreadySaved || saveState === "saved" ? "Remove from saved" : "Save place"}
              aria-pressed={alreadySaved || saveState === "saved"}
              className="w-9 h-9 inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-50"
              style={{
                background: "var(--panel-input-bg, rgba(255,255,255,0.05))",
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
              className="w-9 h-9 inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-50"
              style={{
                background: "var(--panel-input-bg, rgba(255,255,255,0.05))",
                color: shareState === "done" ? "#22c55e" : "var(--panel-text)",
              }}
            >
              {shareState === "done" ? (
                <Check className="w-4 h-4" />
              ) : (
                <Share2 className="w-4 h-4" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close place card"
              className="w-9 h-9 inline-flex items-center justify-center rounded-full"
              style={{
                background: "var(--panel-input-bg, rgba(255,255,255,0.05))",
                color: "var(--panel-text-muted, #9ca3af)",
              }}
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Action button row — Directions stays the visual hero (filled
            blue), Start / Ask / Site|Call are secondary pills that fan
            out next to it. The row scrolls horizontally on narrow
            screens so we never collapse a button into an icon-only
            blob and never wrap below the address line. */}
        <div className="mt-3 flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
          <button
            type="button"
            onClick={() => onDirections(place)}
            className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors"
            style={{ background: "#3b82f6", color: "white" }}
          >
            <Navigation className="w-4 h-4" />
            Directions
          </button>

          {onStart && (
            <button
              type="button"
              onClick={() => onStart(place)}
              className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium transition-colors"
              style={{
                background: "var(--panel-input-bg, rgba(255,255,255,0.05))",
                border: "1px solid var(--panel-input-border, rgba(255,255,255,0.10))",
                color: "var(--panel-text)",
              }}
              aria-label="Start live navigation"
              title="Start live navigation"
            >
              <Play className="w-4 h-4 fill-current" />
              Start
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              // Open Ask Pulse and seed it with this place. The Ask
              // panel listens for `pp:ask-prompt` to pre-fill its
              // input — falls back to plain panel open if the
              // listener isn't ready yet.
              try {
                window.dispatchEvent(
                  new CustomEvent("pp:ask-prompt", {
                    detail: { prompt: `Tell me about ${place.name}` },
                  })
                );
              } catch {
                /* ignore */
              }
              openAskPulseTab();
            }}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium transition-colors"
            style={{
              background: "var(--panel-input-bg, rgba(255,255,255,0.05))",
              border: "1px solid var(--panel-input-border, rgba(255,255,255,0.10))",
              color: "var(--panel-text)",
            }}
            aria-label="Ask Pulse about this place"
            title="Ask Pulse about this place"
          >
            <Sparkles className="w-4 h-4" />
            Ask
          </button>

          {websiteUrl ? (
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium transition-colors"
              style={{
                background: "var(--panel-input-bg, rgba(255,255,255,0.05))",
                border: "1px solid var(--panel-input-border, rgba(255,255,255,0.10))",
                color: "var(--panel-text)",
              }}
              aria-label="Open website"
              title="Open website"
            >
              <Globe className="w-4 h-4" />
              Site
            </a>
          ) : phoneNumber ? (
            <a
              href={`tel:${phoneNumber.replace(/[^\d+]/g, "")}`}
              className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium transition-colors"
              style={{
                background: "var(--panel-input-bg, rgba(255,255,255,0.05))",
                border: "1px solid var(--panel-input-border, rgba(255,255,255,0.10))",
                color: "var(--panel-text)",
              }}
              aria-label={`Call ${phoneNumber}`}
              title={`Call ${phoneNumber}`}
            >
              <Phone className="w-4 h-4" />
              Call
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
