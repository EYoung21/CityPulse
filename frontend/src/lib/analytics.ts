import type { Incident } from "./api";
import { severityBucket, type SeverityBucket } from "./severity";

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
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

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrendPoint {
  date: string;
  count: number;
}

export interface CategoryTrend {
  category: string;
  label: string;
  color: string;
  data: TrendPoint[];
}

export const TREND_CATEGORIES: { cats: string[]; label: string; color: string }[] = [
  { cats: ["violent_weapon", "violent_no_weapon", "shots_heard", "robbery", "burglary_in_progress"], label: "Violent", color: "#ef4444" },
  { cats: ["medical_priority", "medical_other"], label: "Medical", color: "#f472b6" },
  { cats: ["traffic_crash_injury", "traffic_crash_no_injury", "traffic_accident", "traffic_hazard", "user_crash", "user_hazard"], label: "Traffic", color: "#3b82f6" },
  { cats: ["fire_hazmat"], label: "Fire", color: "#fb923c" },
  { cats: ["disorder", "admin_or_noise", "user_disorder"], label: "Disorder", color: "#8b5cf6" },
];

const SEVERITY_BUCKET_META: { bucket: SeverityBucket; label: string; color: string }[] = [
  { bucket: "violent",  label: "Violent",  color: "#ef4444" },
  { bucket: "fire",     label: "Fire",     color: "#fb923c" },
  { bucket: "medical",  label: "Medical",  color: "#f472b6" },
  { bucket: "property", label: "Property", color: "#a78bfa" },
  { bucket: "traffic",  label: "Traffic",  color: "#3b82f6" },
  { bucket: "other",    label: "Other",    color: "#94a3b8" },
];

export function getSeverityBucketMeta() {
  return SEVERITY_BUCKET_META;
}

export function trendByDay(
  incidents: Incident[],
  days: number = 30
): CategoryTrend[] {
  const now = Date.now();
  const cutoff = now - days * DAY_MS;
  const filtered = incidents.filter(
    (i) => new Date(i.reported_at).getTime() >= cutoff
  );

  const dateKeys: string[] = [];
  for (let d = 0; d < days; d++) {
    const dt = new Date(now - (days - 1 - d) * DAY_MS);
    dateKeys.push(dt.toISOString().slice(0, 10));
  }

  return TREND_CATEGORIES.map(({ cats, label, color }) => {
    const countMap: Record<string, number> = {};
    for (const dk of dateKeys) countMap[dk] = 0;
    for (const inc of filtered) {
      if (cats.includes(inc.severity_category)) {
        const dk = new Date(inc.reported_at).toISOString().slice(0, 10);
        if (dk in countMap) countMap[dk]++;
      }
    }
    return {
      category: cats[0],
      label,
      color,
      data: dateKeys.map((dk) => ({ date: dk, count: countMap[dk] })),
    };
  });
}

/** 7x24 matrix: [dayOfWeek 0=Mon .. 6=Sun][hour 0-23] */
export function timeGrid(incidents: Incident[]): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () =>
    Array(24).fill(0) as number[]
  );
  for (const inc of incidents) {
    const dt = new Date(inc.reported_at);
    const dow = (dt.getDay() + 6) % 7;
    grid[dow][dt.getHours()]++;
  }
  return grid;
}

/** Per-hour counts for a 24-hour clock. */
export function hourDistribution(incidents: Incident[]): number[] {
  const hours = Array(24).fill(0) as number[];
  for (const inc of incidents) {
    hours[new Date(inc.reported_at).getHours()]++;
  }
  return hours;
}

export interface CategoryComparison {
  label: string;
  color: string;
  areaRate: number;
  cityRate: number;
}

export function areaVsCityComparison(
  areaIncidents: Incident[],
  allIncidents: Incident[]
): CategoryComparison[] {
  const areaTotal = Math.max(areaIncidents.length, 1);
  const cityTotal = Math.max(allIncidents.length, 1);

  return TREND_CATEGORIES.map(({ cats, label, color }) => {
    const areaCount = areaIncidents.filter((i) =>
      cats.includes(i.severity_category)
    ).length;
    const cityCount = allIncidents.filter((i) =>
      cats.includes(i.severity_category)
    ).length;
    return {
      label,
      color,
      areaRate: areaCount / areaTotal,
      cityRate: cityCount / cityTotal,
    };
  });
}

export function routeSafetyByHour(
  routeGeometry: [number, number][],
  incidents: Incident[],
  bufferKm: number = 0.2
): number[] {
  const hours = Array(24).fill(0) as number[];
  const nearby = incidents.filter((inc) => {
    if (inc.lat == null || inc.lng == null) return false;
    for (let i = 0; i < routeGeometry.length; i += 5) {
      const [rlat, rlng] = routeGeometry[i];
      if (haversineKm(inc.lat, inc.lng, rlat, rlng) <= bufferKm) return true;
    }
    return false;
  });
  for (const inc of nearby) {
    hours[new Date(inc.reported_at).getHours()]++;
  }
  return hours;
}

export function bestTravelWindow(hourCounts: number[]): {
  startHour: number;
  endHour: number;
  avgIncidents: number;
} {
  let bestStart = 0;
  let bestSum = Infinity;
  for (let start = 0; start < 24; start++) {
    const sum = hourCounts[start] + hourCounts[(start + 1) % 24];
    if (sum < bestSum) {
      bestSum = sum;
      bestStart = start;
    }
  }
  return {
    startHour: bestStart,
    endHour: (bestStart + 2) % 24,
    avgIncidents: bestSum / 2,
  };
}

export function incidentsNearRoute(
  routeGeometry: [number, number][],
  incidents: Incident[],
  bufferKm: number = 0.2
): Incident[] {
  return incidents.filter((inc) => {
    if (inc.lat == null || inc.lng == null) return false;
    for (let i = 0; i < routeGeometry.length; i += 5) {
      const [rlat, rlng] = routeGeometry[i];
      if (haversineKm(inc.lat, inc.lng, rlat, rlng) <= bufferKm) return true;
    }
    return false;
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers added for the AnalyticsPanel rebuild.
// All pure, all derive from the existing Incident schema only.
// ───────────────────────────────────────────────────────────────────────────

/** Filter to a trailing window. `Infinity` passes everything through. */
export function withinWindow(incidents: Incident[], hours: number): Incident[] {
  if (!Number.isFinite(hours)) return incidents.slice();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return incidents.filter((i) => {
    const t = Date.parse(i.reported_at);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** Sum of `s_base` per day for the trailing `days` window. Surfaces
 *  whether activity was actually more *severe* (not just louder). */
export function severityIndexByDay(
  incidents: Incident[],
  days: number = 30
): number[] {
  const now = Date.now();
  const out = new Array(days).fill(0) as number[];
  for (const inc of incidents) {
    const t = Date.parse(inc.reported_at);
    if (!Number.isFinite(t)) continue;
    const dayIdx = days - 1 - Math.floor((now - t) / DAY_MS);
    if (dayIdx < 0 || dayIdx >= days) continue;
    out[dayIdx] += Math.max(0, Number(inc.s_base) || 0);
  }
  return out;
}

export interface CategoryDelta {
  label: string;
  color: string;
  current: number;
  prior: number;
  /** `null` when prior window is zero (delta undefined). */
  pct: number | null;
}

/** Per-category counts comparing `windowHours` vs the equally sized prior window. */
export function categoryWoW(
  incidents: Incident[],
  windowHours: number
): CategoryDelta[] {
  if (!Number.isFinite(windowHours)) {
    return TREND_CATEGORIES.map(({ label, color }) => ({
      label,
      color,
      current: 0,
      prior: 0,
      pct: null,
    }));
  }
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const curStart = now - windowMs;
  const prevStart = curStart - windowMs;
  return TREND_CATEGORIES.map(({ cats, label, color }) => {
    let current = 0;
    let prior = 0;
    for (const inc of incidents) {
      if (!cats.includes(inc.severity_category)) continue;
      const t = Date.parse(inc.reported_at);
      if (!Number.isFinite(t)) continue;
      if (t >= curStart) current++;
      else if (t >= prevStart) prior++;
    }
    const pct =
      prior === 0 ? (current === 0 ? 0 : null) : Math.round(((current - prior) / prior) * 100);
    return { label, color, current, prior, pct };
  });
}

export interface BucketShare {
  bucket: SeverityBucket;
  label: string;
  color: string;
  count: number;
  share: number;
}

export function severityBucketMix(incidents: Incident[]): BucketShare[] {
  const counts: Record<SeverityBucket, number> = {
    violent: 0,
    fire: 0,
    medical: 0,
    property: 0,
    traffic: 0,
    other: 0,
  };
  for (const inc of incidents) {
    counts[severityBucket(inc.severity_category)]++;
  }
  const total = incidents.length || 1;
  return SEVERITY_BUCKET_META.map(({ bucket, label, color }) => ({
    bucket,
    label,
    color,
    count: counts[bucket],
    share: counts[bucket] / total,
  }));
}

export interface Hotspot {
  /** Trimmed display version of `location_text`. */
  label: string;
  /** Lower-cased grouping key. */
  key: string;
  count: number;
  topCategory: string;
  topCategoryCount: number;
  /** ISO of the most recent incident in the cluster. */
  lastSeen: string;
  /** Centroid of geocoded incidents in the cluster (null if none). */
  lat: number | null;
  lng: number | null;
}

/** Top recurring `location_text` values, paired with their dominant
 *  category and last-seen timestamp. Skips entries with no
 *  `location_text`; falls back to coarse lat/lng rounding when present. */
export function topHotspots(incidents: Incident[], n: number = 10): Hotspot[] {
  type Acc = {
    label: string;
    count: number;
    catCounts: Record<string, number>;
    lastSeenMs: number;
    lastSeenIso: string;
    latSum: number;
    lngSum: number;
    geoCount: number;
  };
  const buckets = new Map<string, Acc>();
  for (const inc of incidents) {
    let key: string | null = null;
    let label: string | null = null;
    if (inc.location_text && inc.location_text.trim()) {
      label = inc.location_text.trim();
      key = label.toLowerCase();
    } else if (inc.lat != null && inc.lng != null) {
      label = `${inc.lat.toFixed(3)}, ${inc.lng.toFixed(3)}`;
      key = `geo:${inc.lat.toFixed(3)},${inc.lng.toFixed(3)}`;
    }
    if (!key || !label) continue;

    let acc = buckets.get(key);
    if (!acc) {
      acc = {
        label,
        count: 0,
        catCounts: {},
        lastSeenMs: 0,
        lastSeenIso: inc.reported_at,
        latSum: 0,
        lngSum: 0,
        geoCount: 0,
      };
      buckets.set(key, acc);
    }
    acc.count++;
    acc.catCounts[inc.severity_category] =
      (acc.catCounts[inc.severity_category] ?? 0) + 1;
    const t = Date.parse(inc.reported_at);
    if (Number.isFinite(t) && t > acc.lastSeenMs) {
      acc.lastSeenMs = t;
      acc.lastSeenIso = inc.reported_at;
    }
    if (inc.lat != null && inc.lng != null) {
      acc.latSum += inc.lat;
      acc.lngSum += inc.lng;
      acc.geoCount++;
    }
  }

  return Array.from(buckets.entries())
    .map(([key, acc]) => {
      const top = Object.entries(acc.catCounts).sort((a, b) => b[1] - a[1])[0];
      return {
        label: acc.label,
        key,
        count: acc.count,
        topCategory: top?.[0] ?? "other",
        topCategoryCount: top?.[1] ?? 0,
        lastSeen: acc.lastSeenIso,
        lat: acc.geoCount > 0 ? acc.latSum / acc.geoCount : null,
        lng: acc.geoCount > 0 ? acc.lngSum / acc.geoCount : null,
      };
    })
    .filter((h) => h.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

export interface DayNightRow {
  bucket: SeverityBucket;
  label: string;
  color: string;
  total: number;
  /** Count in [22:00, 05:00). */
  night: number;
  /** Share of total that is night. */
  nightShare: number;
}

const NIGHT_START = 22;
const NIGHT_END = 5;

export function dayNightByBucket(incidents: Incident[]): DayNightRow[] {
  const buckets: Record<SeverityBucket, { total: number; night: number }> = {
    violent: { total: 0, night: 0 },
    fire: { total: 0, night: 0 },
    medical: { total: 0, night: 0 },
    property: { total: 0, night: 0 },
    traffic: { total: 0, night: 0 },
    other: { total: 0, night: 0 },
  };
  for (const inc of incidents) {
    const b = severityBucket(inc.severity_category);
    const hour = new Date(inc.reported_at).getHours();
    buckets[b].total++;
    if (hour >= NIGHT_START || hour < NIGHT_END) buckets[b].night++;
  }
  return SEVERITY_BUCKET_META.map(({ bucket, label, color }) => {
    const stats = buckets[bucket];
    return {
      bucket,
      label,
      color,
      total: stats.total,
      night: stats.night,
      nightShare: stats.total > 0 ? stats.night / stats.total : 0,
    };
  }).filter((r) => r.total > 0);
}

export interface FeedShare {
  feedId: string;
  label: string;
  count: number;
  share: number;
}

export function feedMix(
  incidents: Incident[],
  feedLabels: Record<string, string> = {}
): FeedShare[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const inc of incidents) {
    if (!inc.feed_id) continue;
    counts.set(inc.feed_id, (counts.get(inc.feed_id) ?? 0) + 1);
    total++;
  }
  if (total === 0) return [];
  return Array.from(counts.entries())
    .map(([feedId, count]) => ({
      feedId,
      label: feedLabels[feedId] || feedId,
      count,
      share: count / total,
    }))
    .sort((a, b) => b.count - a.count);
}

export interface DataQuality {
  total: number;
  geocoded: number;
  geocodedShare: number;
  withMentions: number;
  meanMentionCount: number;
  medianConfidence: number;
  /** Distribution across `inhibitor_status` values found in the slice. */
  inhibitorBreakdown: { status: string; count: number; share: number }[];
}

export function dataQuality(incidents: Incident[]): DataQuality {
  const total = incidents.length;
  if (total === 0) {
    return {
      total: 0,
      geocoded: 0,
      geocodedShare: 0,
      withMentions: 0,
      meanMentionCount: 0,
      medianConfidence: 0,
      inhibitorBreakdown: [],
    };
  }
  let geocoded = 0;
  let withMentions = 0;
  let mentionSum = 0;
  const confidences: number[] = [];
  const inhibCounts = new Map<string, number>();
  for (const inc of incidents) {
    if (inc.lat != null && inc.lng != null) geocoded++;
    const m = inc.mention_count ?? 0;
    if (m > 1) withMentions++;
    mentionSum += Math.max(1, m);
    if (typeof inc.confidence === "number") confidences.push(inc.confidence);
    const status = inc.inhibitor_status || "unknown";
    inhibCounts.set(status, (inhibCounts.get(status) ?? 0) + 1);
  }
  const sorted = confidences.slice().sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) >> 1]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const inhibitorBreakdown = Array.from(inhibCounts.entries())
    .map(([status, count]) => ({ status, count, share: count / total }))
    .sort((a, b) => b.count - a.count);
  return {
    total,
    geocoded,
    geocodedShare: geocoded / total,
    withMentions,
    meanMentionCount: mentionSum / total,
    medianConfidence: median,
    inhibitorBreakdown,
  };
}

/** "Active right now" — incidents whose latest mention is within the
 *  trailing `windowMin` minutes AND have at least 2 mentions (i.e. an
 *  ongoing scanner thread). */
export function activeNowCount(incidents: Incident[], windowMin: number = 30): number {
  const cutoff = Date.now() - windowMin * 60 * 1000;
  let n = 0;
  for (const inc of incidents) {
    const lastIso = inc.last_mention_at;
    if (!lastIso) continue;
    const t = Date.parse(lastIso);
    if (!Number.isFinite(t)) continue;
    if (t >= cutoff && (inc.mention_count ?? 0) >= 2) n++;
  }
  return n;
}

/** GitHub-style calendar grid: `weeks` columns × 7 rows. Cell is the
 *  count of incidents on that calendar day, in user-local time. */
export function calendarGrid(
  incidents: Incident[],
  weeks: number = 12
): { date: string; count: number }[][] {
  const days = weeks * 7;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const cells: { date: string; count: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startOfToday.getTime() - (days - 1 - i) * DAY_MS);
    cells.push({ date: d.toISOString().slice(0, 10), count: 0 });
  }
  const idxByKey = new Map(cells.map((c, i) => [c.date, i]));
  for (const inc of incidents) {
    const t = Date.parse(inc.reported_at);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    const key = d.toISOString().slice(0, 10);
    const idx = idxByKey.get(key);
    if (idx == null) continue;
    cells[idx].count++;
  }
  const cols: { date: string; count: number }[][] = [];
  for (let w = 0; w < weeks; w++) {
    cols.push(cells.slice(w * 7, (w + 1) * 7));
  }
  return cols;
}

/** Human-readable label for a `severity_category`. Falls back to the
 *  raw key with underscores stripped if not in the lookup. */
export function categoryDisplay(cat: string): string {
  const map: Record<string, string> = {
    violent_weapon: "Violent (weapon)",
    violent_no_weapon: "Violent",
    shots_heard: "Shots heard",
    robbery: "Robbery",
    burglary: "Burglary",
    burglary_in_progress: "Burglary in progress",
    theft: "Theft",
    vandalism: "Vandalism",
    disorder: "Disorder",
    admin_or_noise: "Admin / noise",
    medical_priority: "Medical (priority)",
    medical_other: "Medical",
    fire_hazmat: "Fire / hazmat",
    traffic_crash_injury: "Crash w/ injury",
    traffic_crash_no_injury: "Crash",
    traffic_accident: "Crash",
    traffic_hazard: "Traffic hazard",
    user_hazard: "User hazard",
    user_crash: "User crash",
    user_police: "User police",
    user_disorder: "User disorder",
    user_other: "User report",
  };
  return map[cat] || cat.replace(/_/g, " ");
}

/** Build a CSV string for the current scope. Columns chosen to be
 *  stable across schema drift — caller is responsible for escaping the
 *  `Content-Disposition` filename. */
export function incidentsToCsv(incidents: Incident[]): string {
  const headers = [
    "id",
    "reported_at",
    "severity_category",
    "s_base",
    "lat",
    "lng",
    "location_text",
    "feed_id",
    "mention_count",
    "last_mention_at",
    "inhibitor_status",
    "geocode_status",
    "confidence",
  ];
  const escape = (v: unknown): string => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = incidents.map((i) =>
    [
      i.id,
      i.reported_at,
      i.severity_category,
      i.s_base,
      i.lat ?? "",
      i.lng ?? "",
      i.location_text ?? "",
      i.feed_id ?? "",
      i.mention_count ?? "",
      i.last_mention_at ?? "",
      i.inhibitor_status ?? "",
      i.geocode_status ?? "",
      i.confidence,
    ]
      .map(escape)
      .join(",")
  );
  return [headers.join(","), ...rows].join("\n");
}

export interface MentionVelocity {
  heatingCount: number;
  meanMentions: number;
  recentUpdates: number;
}

export function mentionVelocity(incidents: Incident[], windowHours: number = 24): MentionVelocity {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  let heatingCount = 0;
  let mentionSum = 0;
  let recentUpdates = 0;
  let n = 0;
  for (const inc of incidents) {
    const t = Date.parse(inc.reported_at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    n++;
    const m = inc.mention_count ?? 1;
    mentionSum += m;
    if (m >= 2) {
      const last = inc.last_mention_at ? Date.parse(inc.last_mention_at) : t;
      if (Number.isFinite(last) && last >= Date.now() - 30 * 60 * 1000) heatingCount++;
      if (m > 1) recentUpdates += m - 1;
    }
  }
  return {
    heatingCount,
    meanMentions: n > 0 ? mentionSum / n : 0,
    recentUpdates,
  };
}

export interface DailyTrendPoint {
  date: string;
  confidence: number;
  geocodedShare: number;
}

export function confidenceTrend(incidents: Incident[], days: number = 14): DailyTrendPoint[] {
  const now = Date.now();
  const keys: string[] = [];
  const buckets = new Map<string, { conf: number[]; geo: number; total: number }>();
  for (let d = 0; d < days; d++) {
    const dt = new Date(now - (days - 1 - d) * DAY_MS);
    const key = dt.toISOString().slice(0, 10);
    keys.push(key);
    buckets.set(key, { conf: [], geo: 0, total: 0 });
  }
  for (const inc of incidents) {
    const t = Date.parse(inc.reported_at);
    if (!Number.isFinite(t)) continue;
    const key = new Date(t).toISOString().slice(0, 10);
    const b = buckets.get(key);
    if (!b) continue;
    b.total++;
    if (typeof inc.confidence === "number") b.conf.push(inc.confidence);
    if (inc.lat != null && inc.lng != null) b.geo++;
  }
  return keys.map((date) => {
    const b = buckets.get(date)!;
    const conf = b.conf.length
      ? b.conf.reduce((s, v) => s + v, 0) / b.conf.length
      : 0;
    return {
      date,
      confidence: conf,
      geocodedShare: b.total > 0 ? b.geo / b.total : 0,
    };
  });
}

export interface InhibitorTrendRow {
  reason: string;
  count: number;
}

export function inhibitorTrend(incidents: Incident[], days: number = 14): InhibitorTrendRow[] {
  const cutoff = Date.now() - days * DAY_MS;
  const counts = new Map<string, number>();
  for (const inc of incidents) {
    const t = Date.parse(inc.reported_at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const reason = inc.inhibitor_reason || inc.inhibitor_status || "unknown";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

export interface FeedWeightShare {
  feedId: string;
  label: string;
  count: number;
  severityWeight: number;
  share: number;
}

export function feedMixWeighted(
  incidents: Incident[],
  feedLabels: Record<string, string> = {}
): FeedWeightShare[] {
  const rows = new Map<string, { count: number; weight: number }>();
  let total = 0;
  for (const inc of incidents) {
    if (!inc.feed_id) continue;
    const w = Math.max(0, Number(inc.s_base) || 0);
    const acc = rows.get(inc.feed_id) ?? { count: 0, weight: 0 };
    acc.count++;
    acc.weight += w;
    rows.set(inc.feed_id, acc);
    total += w;
  }
  if (total === 0) return [];
  return Array.from(rows.entries())
    .map(([feedId, acc]) => ({
      feedId,
      label: feedLabels[feedId] || feedId,
      count: acc.count,
      severityWeight: acc.weight,
      share: acc.weight / total,
    }))
    .sort((a, b) => b.severityWeight - a.severityWeight);
}

export interface GeoCell {
  key: string;
  lat: number;
  lng: number;
  count: number;
}

export function geoDensityGrid(incidents: Incident[], precision = 2): GeoCell[] {
  const cells = new Map<string, GeoCell>();
  for (const inc of incidents) {
    if (inc.lat == null || inc.lng == null) continue;
    const lat = Number(inc.lat.toFixed(precision));
    const lng = Number(inc.lng.toFixed(precision));
    const key = `${lat},${lng}`;
    const cell = cells.get(key) ?? { key, lat, lng, count: 0 };
    cell.count++;
    cells.set(key, cell);
  }
  return Array.from(cells.values()).sort((a, b) => b.count - a.count);
}
