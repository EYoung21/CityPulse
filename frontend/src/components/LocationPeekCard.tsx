"use client";

/** "What's happening here?" peek card.
 *
 *  Triggered by a long-press / right-click on the map (the gesture
 *  used to drop a user-report pin before that feature was removed in
 *  commit 415e7e3). This is purely informational — no save, no write
 *  state — so an accidental long-press costs the user nothing.
 *
 *  Render contract: same bottom-3 / calc(sidebar+1rem) slot as
 *  SafetyScoreCard, ClusterListPanel, IncidentDetail. The parent is
 *  responsible for ensuring only one of those is mounted at a time.
 *
 *  No LLM calls. The summary is a deterministic count of incidents
 *  within `radiusKm` whose `reported_at` is within `windowHours`,
 *  bucketed by the same CATEGORY_PILLS the map clusters use.
 *  Long-press is a reflexive gesture and people will trigger it
 *  constantly out of curiosity — paying $0.0003 per peek would balloon
 *  fast. If we ever want LLM prose, add a discrete "Summarize" button
 *  on the card and gate that, not the gesture itself. */

import { useEffect, useMemo, useState } from "react";
import { Clock, MapPin, X } from "lucide-react";
import type { Incident } from "@/lib/api";
import { reverseGeocode } from "@/lib/search";
import TransitArrivalsCard from "@/components/TransitArrivalsCard";

interface CategoryPill {
  readonly label: string;
  readonly cats: readonly string[];
  readonly color: string;
}

interface Props {
  lat: number;
  lng: number;
  incidents: Incident[];
  /** The same CATEGORY_PILLS table used by the chips bar. Passed in
   *  rather than imported so the card stays decoupled from page.tsx
   *  and can be reused (e.g. in admin tooling) later. */
  categoryPills: readonly CategoryPill[];
  onClose: () => void;
  /** Radius for the "near here" filter, in km. 0.5 = 500m, which is
   *  about a 6-min walk and matches the perceived "neighborhood
   *  block" people expect when they tap the map. */
  radiusKm?: number;
  /** Trailing time window for "recent" incidents. Default 1h matches
   *  the free-tier time chip so a free user sees the same data the
   *  rest of the UI shows them. */
  windowHours?: number;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatRelative(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "-";
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export default function LocationPeekCard({
  lat,
  lng,
  incidents,
  categoryPills,
  onClose,
  radiusKm = 0.5,
  windowHours = 1,
}: Props) {
  const [now] = useState(Date.now);
  const locationKey = `${lat},${lng}`;
  const [addressResult, setAddressResult] = useState<{
    key: string;
    label: string | null;
  } | null>(null);

  // Reverse-geocode runs once per (lat, lng); the upstream
  // long-press handler already debounces multi-touch so we don't need
  // to throttle here. Failure falls back to formatted coords below.
  useEffect(() => {
    let cancelled = false;
    reverseGeocode(lat, lng)
      .then((label) => {
        if (!cancelled) setAddressResult({ key: locationKey, label });
      })
      .catch(() => {
        // Network blip / Nominatim 429 — silently fall back to coords.
        // The card still renders meaningfully without an address.
        if (!cancelled) setAddressResult({ key: locationKey, label: null });
      });
    return () => {
      cancelled = true;
    };
  }, [lat, lng, locationKey]);

  const address = addressResult?.key === locationKey ? addressResult.label : null;
  const addressLoading = addressResult?.key !== locationKey;

  // Filter the in-memory `incidents` array. Cheap (<1ms for ~10k
  // incidents) so we don't bother memoizing across renders.
  const { mostRecent, byCategory, total } = useMemo(() => {
    const cutoff = now - windowHours * 60 * 60 * 1000;
    const matched: Incident[] = [];
    for (const inc of incidents) {
      if (inc.lat == null || inc.lng == null) continue;
      const ts = Date.parse(inc.reported_at);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const dist = haversineKm(lat, lng, inc.lat, inc.lng);
      if (dist <= radiusKm) matched.push(inc);
    }
    // Bucket by the same pill table the chips bar uses so colors and
    // labels stay consistent — no separate "Other" because anything
    // outside the pill table is already filtered upstream.
    const buckets: { pill: CategoryPill; count: number }[] = categoryPills
      .map((p) => ({
        pill: p,
        count: matched.filter((m) => p.cats.includes(m.severity_category)).length,
      }))
      .filter((b) => b.count > 0)
      .sort((a, b) => b.count - a.count);
    const mr = matched.reduce<Incident | null>((best, curr) => {
      if (!best) return curr;
      return Date.parse(curr.reported_at) > Date.parse(best.reported_at) ? curr : best;
    }, null);
    return {
      mostRecent: mr,
      byCategory: buckets,
      total: matched.length,
    };
  }, [incidents, lat, lng, radiusKm, windowHours, categoryPills, now]);

  const heading =
    address?.trim() ||
    (addressLoading ? "Locating…" : `${lat.toFixed(4)}, ${lng.toFixed(4)}`);

  // The mostRecent label needs a category pill name; look it up.
  const mostRecentPill = mostRecent
    ? categoryPills.find((p) => p.cats.includes(mostRecent.severity_category))
    : null;

  return (
    <div
      className="rounded-xl shadow-2xl backdrop-blur-md p-3 space-y-2.5"
      style={{
        background: "var(--panel-bg, rgba(15,15,25,0.95))",
        border: "1px solid var(--panel-border, rgba(255,255,255,0.08))",
        color: "var(--panel-text, #e5e7eb)",
      }}
    >
      <div className="flex items-start gap-2">
        <MapPin className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "#a855f7" }} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold leading-snug truncate">{heading}</div>
          <div
            className="text-[10px] mt-0.5"
            style={{ color: "var(--panel-text-muted, #9ca3af)" }}
          >
            Last {windowHours}h within {Math.round(radiusKm * 1000)}m
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close location peek"
          className="p-1 -m-1 rounded"
          style={{ color: "var(--panel-text-muted, #9ca3af)" }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {total === 0 ? (
        <div
          className="text-[11px] py-1"
          style={{ color: "var(--panel-text-secondary, #9ca3af)" }}
        >
          No incidents reported in this window. The neighborhood is quiet.
        </div>
      ) : (
        <>
          <div className="space-y-1">
            {byCategory.map(({ pill, count }) => (
              <div key={pill.label} className="flex items-center gap-2 text-[11px]">
                <span
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ background: pill.color }}
                />
                <span className="flex-1">{pill.label}</span>
                <span className="font-mono tabular-nums">{count}</span>
              </div>
            ))}
          </div>

          {mostRecent && (
            <div
              className="flex items-center gap-1.5 text-[10px] pt-1.5 border-t"
              style={{
                color: "var(--panel-text-muted, #9ca3af)",
                borderColor: "var(--panel-border, rgba(255,255,255,0.08))",
              }}
            >
              <Clock className="w-3 h-3" />
              <span>
                Most recent: {formatRelative(mostRecent.reported_at, now)}
                {mostRecentPill ? ` · ${mostRecentPill.label.toLowerCase()}` : ""}
              </span>
            </div>
          )}
        </>
      )}

      {/* Nearby transit arrivals — dispatches by city (SEPTA in
          philly, BART in sf). Self-gates: renders nothing when no
          station is within range or when the active city has no
          supported provider, so mounting it unconditionally is safe. */}
      <TransitArrivalsCard lat={lat} lng={lng} />
    </div>
  );
}
