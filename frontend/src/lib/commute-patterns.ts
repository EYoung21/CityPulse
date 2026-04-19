"use client";

/** Pattern detection over completed trip history.
 *
 *  Goal: derive lightweight predictions like "you usually head to
 *  Work around 8:15 AM" from the existing on-device trip log without
 *  any ML or server round-trip. The output drives a passive nudge
 *  next to the Home/Work quick-route chips when the current time is
 *  near a recurring departure window.
 *
 *  Algorithm:
 *    1. Read recent (≤30d) completed trips from `lib/trip-history`.
 *    2. Cluster by destination (≈150m radius, simple greedy DBSCAN-
 *       style growth — fine for an O(n²) input that's almost never
 *       larger than a few dozen entries).
 *    3. For each cluster with ≥`MIN_SAMPLES` trips, bucket the start
 *       times by *day-of-week + half-hour bin*. A weekday-only or
 *       weekend-only bucket counts as a stronger signal than a
 *       cluster spread evenly across the week.
 *    4. The "typical departure" is the median start-minute of all
 *       trips in the cluster's strongest bucket; "typical duration"
 *       is the median traveled time.
 *    5. The predictor returns the bucket whose typical departure is
 *       closest to "now" within ±`MATCH_WINDOW_MIN` and whose sample
 *       size is high enough to be trusted.
 *
 *  Honesty:
 *    Trips with no `dest` (legacy entries) are skipped. The cluster
 *    label is "best effort" — we use the most-common destination
 *    label across cluster members, falling back to "Saved place" if
 *    they all differ. The user's saved Home/Work pin (if any) is
 *    preferred as the cluster label so the prediction text can read
 *    "head to Work" instead of "head to 1500 Market St". */

import type { SavedDestination } from "@/hooks/useSavedDestinations";
import { getTripHistory, type TripHistoryEntry } from "@/lib/trip-history";

const LOOKBACK_DAYS = 30;
const CLUSTER_RADIUS_M = 150;
const MIN_SAMPLES = 3;
const MATCH_WINDOW_MIN = 75;

interface Cluster {
  /** Centroid (running average) of cluster member destinations. */
  lat: number;
  lng: number;
  members: TripHistoryEntry[];
  /** Most-common label across members, used as a friendly fallback
   *  when no Home/Work tag matches. */
  label: string;
}

export interface CommutePrediction {
  destLat: number;
  destLng: number;
  destLabel: string;
  /** "home" / "work" if the cluster centroid lines up with a saved
   *  Home or Work pin; otherwise null. The UI uses this to badge the
   *  prediction with the right icon and avoid duplicating chips. */
  matchedCategory: "home" | "work" | null;
  /** 0..1439 — minute-of-day median start time. */
  typicalDepartureMinute: number;
  /** Median traveled minutes for this cluster's matching bucket. */
  typicalDurationMin: number;
  /** How many trips support this prediction. */
  sampleSize: number;
  /** Crude confidence: clamped (sampleSize / 8). UI can use this to
   *  decide between "you usually" vs "you sometimes" phrasing. */
  confidence: number;
  /** The bucket key the prediction came from, for de-dup against a
   *  per-day "I dismissed this" flag. */
  bucketKey: string;
}

const R_KM = 6371;
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(sa)));
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function buildClusters(trips: TripHistoryEntry[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const t of trips) {
    if (!t.dest) continue;
    const member = t.dest;
    let target: Cluster | null = null;
    for (const c of clusters) {
      if (haversineKm(c, member) * 1000 <= CLUSTER_RADIUS_M) {
        target = c;
        break;
      }
    }
    if (target) {
      // Walking-mean centroid keeps the cluster anchor stable as it
      // grows. Not perfect under heavy jitter but trips of the same
      // destination rarely vary by >50m so it's fine.
      const n = target.members.length;
      target.lat = (target.lat * n + member.lat) / (n + 1);
      target.lng = (target.lng * n + member.lng) / (n + 1);
      target.members.push(t);
    } else {
      clusters.push({
        lat: member.lat,
        lng: member.lng,
        members: [t],
        label: member.display_name,
      });
    }
  }
  // Replace each cluster's label with the most-common label among
  // members (handles the case where small geocoding differences land
  // the same building under slightly different names).
  for (const c of clusters) {
    const counts = new Map<string, number>();
    for (const m of c.members) {
      const lab = m.dest?.display_name ?? "";
      if (!lab) continue;
      counts.set(lab, (counts.get(lab) ?? 0) + 1);
    }
    let best: { label: string; n: number } | null = null;
    for (const [label, n] of counts) {
      if (!best || n > best.n) best = { label, n };
    }
    if (best) c.label = best.label;
  }
  return clusters;
}

/** Returns a prediction for the cluster best matching the current
 *  local time, or null if no cluster meets the support threshold or
 *  is close enough to "now" to be relevant.
 *
 *  `savedDestinations` (optional) lets the caller pass the user's
 *  Home/Work pins so the prediction can be tagged + labelled
 *  accordingly. */
export function predictNextCommute(
  savedDestinations: SavedDestination[] = [],
  now: Date = new Date()
): CommutePrediction | null {
  const cutoff = now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60_000;
  const trips = getTripHistory().filter(
    (t) => t.startedAt >= cutoff && t.completed && t.dest
  );
  if (trips.length < MIN_SAMPLES) return null;

  const clusters = buildClusters(trips);
  const dow = now.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const nowMinute = now.getHours() * 60 + now.getMinutes();

  let best: CommutePrediction | null = null;

  for (const c of clusters) {
    if (c.members.length < MIN_SAMPLES) continue;

    // Bucket members by half-hour-of-day, conditioned on weekday vs
    // weekend (so a 7am workday cluster doesn't get diluted by an
    // unrelated Saturday morning trip to the same address).
    const buckets = new Map<string, TripHistoryEntry[]>();
    for (const m of c.members) {
      const d = new Date(m.startedAt);
      const memWeekend = d.getDay() === 0 || d.getDay() === 6;
      // Only consider members in the same weekday/weekend regime as
      // "now" — weekend predictions shouldn't fire on a Tuesday.
      if (memWeekend !== isWeekend) continue;
      const halfHour = Math.floor((d.getHours() * 60 + d.getMinutes()) / 30);
      const key = `${memWeekend ? "we" : "wd"}:${halfHour}`;
      const arr = buckets.get(key) ?? [];
      arr.push(m);
      buckets.set(key, arr);
    }

    for (const [bucketKey, bucket] of buckets) {
      if (bucket.length < MIN_SAMPLES) continue;
      const departureMin = median(bucket.map((b) => {
        const d = new Date(b.startedAt);
        return d.getHours() * 60 + d.getMinutes();
      }));
      const delta = Math.abs(departureMin - nowMinute);
      // Wrap around midnight for late-night clusters (e.g. an 11:30pm
      // last-train run versus 12:30am).
      const wrappedDelta = Math.min(delta, 1440 - delta);
      if (wrappedDelta > MATCH_WINDOW_MIN) continue;

      const durationMin = median(bucket.map((b) => Math.max(1, (b.endedAt - b.startedAt) / 60_000)));

      // Prefer clusters with both larger sample sizes and tighter
      // time-of-day proximity. Score = sampleSize − Δminutes/30 so
      // each extra half-hour off "now" costs one sample.
      const score = bucket.length - wrappedDelta / 30;
      if (best && score <= sampleScore(best, nowMinute)) continue;

      // Snap the prediction's category/label to the user's saved
      // Home/Work pin if the cluster centroid is within 200m. Lets
      // the UI say "Heading home" instead of a long street address.
      let matched: "home" | "work" | null = null;
      let label = c.label;
      for (const sd of savedDestinations) {
        if (sd.category !== "home" && sd.category !== "work") continue;
        if (haversineKm({ lat: c.lat, lng: c.lng }, sd) * 1000 < 200) {
          matched = sd.category;
          label = sd.name;
          break;
        }
      }

      best = {
        destLat: c.lat,
        destLng: c.lng,
        destLabel: label.split(",")[0] || label,
        matchedCategory: matched,
        typicalDepartureMinute: departureMin,
        typicalDurationMin: durationMin,
        sampleSize: bucket.length,
        confidence: Math.min(1, bucket.length / 8),
        bucketKey,
      };
    }
  }

  return best;
}

function sampleScore(p: CommutePrediction, nowMinute: number): number {
  const delta = Math.abs(p.typicalDepartureMinute - nowMinute);
  const wrapped = Math.min(delta, 1440 - delta);
  return p.sampleSize - wrapped / 30;
}

/** Format a minute-of-day as a locale string. */
export function formatDepartureTime(minute: number): string {
  const d = new Date();
  d.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
