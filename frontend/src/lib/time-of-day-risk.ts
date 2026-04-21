"use client";

/** Time-of-day risk profile for a location.
 *
 *  Aggregates incidents within a radius of a point by hour-of-day in
 *  the user's local timezone. The resulting 24-bar curve answers the
 *  question "how does *now* compare to other times of day at this
 *  exact spot?" — something neither Google Maps nor Citizen surfaces.
 *
 *  Why client-side:
 *    - We already have all in-window incidents loaded for the map;
 *      no extra fetch needed.
 *    - Hour-of-day shape is location-stable enough that a few hundred
 *      data points is plenty — we don't need ML or a server roll-up.
 *
 *  Honesty constraints:
 *    - Returns `enoughData: false` when there are fewer than
 *      `MIN_INCIDENTS_FOR_CURVE` matching incidents inside the
 *      radius. The UI uses this flag to suppress the curve rather
 *      than draw a misleading sparse profile.
 *    - We use raw counts per bucket, not normalized "incidents per
 *      hour-of-day-occurrence", because we don't track exposure time
 *      and the user mostly wants relative shape (when is this place
 *      more/less active?), not an absolute rate.
 */

import type { Incident } from "@/lib/api";

const R_KM = 6371;
const MIN_INCIDENTS_FOR_CURVE = 8;

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(sa)));
}

export interface TimeOfDayProfile {
  /** 24 entries, indexed by local hour 0..23. */
  buckets: number[];
  /** Hour with the most incidents (0..23). */
  peakHour: number;
  /** Hour with the fewest (0..23, ties resolved to the earliest). */
  trough: number;
  /** Total incidents the curve was built from. */
  total: number;
  /** Local hour at the time the profile was computed. */
  currentHour: number;
  /** True when there were enough incidents to draw a meaningful
   *  curve. UI must check this before rendering. */
  enoughData: boolean;
  /** Bucket value at currentHour. */
  currentBucket: number;
  /** Multiplicative ratio of currentBucket vs the curve's mean. >1
   *  means worse-than-typical right now, <1 means better. Returns 1
   *  if mean is 0. */
  currentVsTypical: number;
}

/** Build a 24-hour risk profile for `center` from all incidents
 *  within `radiusKm`. Default radius matches the SafetyScoreCard's
 *  0.8 km nearby threshold so the curve and headline numbers refer
 *  to the same set of incidents. */
export function buildTimeOfDayProfile(
  center: { lat: number; lng: number },
  incidents: Incident[],
  radiusKm = 0.8,
  now: Date = new Date()
): TimeOfDayProfile {
  const buckets = new Array<number>(24).fill(0);
  let total = 0;

  for (const inc of incidents) {
    if (inc.lat == null || inc.lng == null) continue;
    if (haversineKm(center, { lat: inc.lat, lng: inc.lng }) > radiusKm) continue;
    const ts = Date.parse(inc.reported_at);
    if (Number.isNaN(ts)) continue;
    const h = new Date(ts).getHours();
    buckets[h] += 1;
    total += 1;
  }

  const currentHour = now.getHours();
  const currentBucket = buckets[currentHour];

  // Find peak / trough. We only consider trough among non-zero
  // buckets to avoid "3 AM is the safest hour" when the truth is
  // just "we have no data for 3 AM".
  let peakHour = 0;
  let peakVal = -1;
  let trough = currentHour;
  let troughVal = Number.POSITIVE_INFINITY;
  for (let h = 0; h < 24; h++) {
    if (buckets[h] > peakVal) { peakVal = buckets[h]; peakHour = h; }
    if (buckets[h] > 0 && buckets[h] < troughVal) { troughVal = buckets[h]; trough = h; }
  }
  if (troughVal === Number.POSITIVE_INFINITY) trough = currentHour;

  const mean = total / 24;
  const currentVsTypical = mean > 0 ? currentBucket / mean : 1;

  return {
    buckets,
    peakHour,
    trough,
    total,
    currentHour,
    enoughData: total >= MIN_INCIDENTS_FOR_CURVE,
    currentBucket,
    currentVsTypical,
  };
}

/** Format an hour as "5 AM" / "11 PM" — locale-independent so the
 *  copy reads consistently regardless of the user's clock setting. */
export function formatHourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12} ${ampm}`;
}

/** One-sentence summary of the curve, suitable for a card subtitle.
 *  Falls back to a "not enough data yet" string when `enoughData` is
 *  false so callers don't have to special-case the null curve. */
export function summarizeProfile(p: TimeOfDayProfile): string {
  if (!p.enoughData) {
    return "Not enough history at this spot yet to show a typical-day pattern.";
  }
  const ratio = p.currentVsTypical;
  const peakLabel = formatHourLabel(p.peakHour);
  if (ratio >= 1.5) {
    return `Right now is busier than typical here · peak is around ${peakLabel}.`;
  }
  if (ratio <= 0.5) {
    return `Quieter than typical right now · peak is around ${peakLabel}.`;
  }
  return `About average for this hour · peak is around ${peakLabel}.`;
}
