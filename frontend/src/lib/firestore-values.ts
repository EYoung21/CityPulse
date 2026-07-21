import type { Incident, IncidentMention, LocationConfidence } from "@/lib/api";

const STALE_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function dateToIso(value: Date): string {
  return Number.isFinite(value.getTime()) ? value.toISOString() : STALE_TIMESTAMP;
}

/** Invalid/missing server timestamps must sort as stale. Treating them as
 * "now" can surface corrupt historical records as current incidents. */
export function normalizeFirestoreTimestamp(value: unknown): string {
  try {
    if (typeof value === "string" && value.trim()) {
      let candidate = value.trim();
      if (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(candidate) &&
        !candidate.endsWith("Z") &&
        !/[+-]\d{2}:?\d{2}$/.test(candidate)
      ) {
        candidate += "Z";
      }
      return dateToIso(new Date(candidate));
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "toDate" in value &&
      typeof (value as { toDate?: unknown }).toDate === "function"
    ) {
      return dateToIso((value as { toDate: () => Date }).toDate());
    }
    if (typeof value === "object" && value !== null && "seconds" in value) {
      const seconds = Number((value as { seconds?: unknown }).seconds);
      if (Number.isFinite(seconds)) return dateToIso(new Date(seconds * 1000));
    }
  } catch {
    // Malformed Timestamp-like objects are stale, never current.
  }
  return STALE_TIMESTAMP;
}

export function normalizeFiniteNumber(
  value: unknown,
  fallback: number,
  minimum?: number,
  maximum?: number,
): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (minimum !== undefined && parsed < minimum) return fallback;
  if (maximum !== undefined && parsed > maximum) return fallback;
  return parsed;
}

export function normalizeFirestoreCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  const marker = Number.NaN;
  const parsed = normalizeFiniteNumber(value, marker, minimum, maximum);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeLocationConfidence(value: unknown): LocationConfidence {
  const normalized = String(value ?? "none");
  return normalized === "direct" || normalized === "context" || normalized === "none"
    ? normalized
    : "none";
}

function boundedText(value: unknown, fallback = "", maxLength = 20_000): string {
  const text = value === null || value === undefined ? fallback : String(value);
  return text.slice(0, maxLength);
}

function nullableText(value: unknown, maxLength = 20_000): string | null {
  return value === null || value === undefined ? null : boundedText(value, "", maxLength);
}

export function normalizeWordTimings(value: unknown): { word: string; start: number; end: number }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { word: string; start: number; end: number }[] = [];
  for (const item of value.slice(0, 5_000)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const start = normalizeFiniteNumber(row.start, Number.NaN, 0);
    const end = normalizeFiniteNumber(row.end, Number.NaN, 0);
    const word = typeof row.word === "string" ? row.word.slice(0, 200) : "";
    if (word && Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      out.push({ word, start, end });
    }
  }
  return out.length > 0 ? out : null;
}

function normalizeMention(value: unknown): IncidentMention | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return {
    at: normalizeFirestoreTimestamp(row.at),
    raw_text: boundedText(row.raw_text),
    audio_clip: nullableText(row.audio_clip, 500),
    audio_url: nullableText(row.audio_url, 2_048),
    feed_id: nullableText(row.feed_id, 200),
    location_text: nullableText(row.location_text, 1_000),
    location_confidence:
      row.location_confidence === null || row.location_confidence === undefined
        ? null
        : normalizeLocationConfidence(row.location_confidence),
    confidence: normalizeFiniteNumber(row.confidence, 0, 0, 1),
    severity_category: boundedText(row.severity_category, "", 100),
    s_base: normalizeFiniteNumber(row.s_base, 0, 0, 1),
    description: nullableText(row.description),
  };
}

/** Normalize an incident from REST, Firestore, or browser cache data. Missing
 * optional fields get safe defaults; an unusable id or non-object row is
 * rejected so downstream map/feed code never receives a structurally invalid
 * incident. */
export function normalizeIncidentRecord(idValue: unknown, value: unknown): Incident | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = boundedText(idValue, "", 500).trim();
  if (!id) return null;

  let lat = normalizeFirestoreCoordinate(row.lat, -90, 90);
  let lng = normalizeFirestoreCoordinate(row.lng, -180, 180);
  if ((lat === null) !== (lng === null)) {
    lat = null;
    lng = null;
  }
  const wordTimings = normalizeWordTimings(row.word_timings);
  const mentions = Array.isArray(row.mentions)
    ? row.mentions.slice(0, 500).map(normalizeMention).filter((item): item is IncidentMention => item !== null)
    : undefined;
  const unitStatus =
    row.unit_status === "dispatched" || row.unit_status === "on_scene" || row.unit_status === "cleared"
      ? row.unit_status
      : null;
  const lifecycleStatus =
    row.lifecycle_status === "still" || row.lifecycle_status === "resolved" || row.lifecycle_status === "unverified"
      ? row.lifecycle_status
      : undefined;

  return {
    id,
    reported_at: normalizeFirestoreTimestamp(row.reported_at),
    raw_text: boundedText(row.raw_text),
    severity_category: boundedText(row.severity_category, "", 100),
    s_base: normalizeFiniteNumber(row.s_base, 0, 0, 1),
    location_text: nullableText(row.location_text, 1_000),
    lat,
    lng,
    confidence: normalizeFiniteNumber(row.confidence, 0, 0, 1),
    geocode_status: boundedText(row.geocode_status, "pending", 100),
    location_confidence: normalizeLocationConfidence(row.location_confidence),
    inhibitor_status: boundedText(row.inhibitor_status, "passed", 100),
    inhibitor_reason: nullableText(row.inhibitor_reason, 1_000),
    w_eff: normalizeFiniteNumber(row.w_eff, 0, 0),
    audio_clip: nullableText(row.audio_clip, 500),
    audio_url: nullableText(row.audio_url, 2_048),
    feed_id: nullableText(row.feed_id, 200),
    description: nullableText(row.description),
    unit_status: unitStatus,
    hidden: row.hidden === true,
    word_timings: wordTimings,
    has_word_timings: row.has_word_timings === true || wordTimings !== null,
    mentions,
    mention_count: Math.max(
      0,
      Math.floor(normalizeFiniteNumber(row.mention_count, mentions?.length ?? 0, 0, 10_000))
    ),
    last_mention_at:
      row.last_mention_at === null || row.last_mention_at === undefined
        ? null
        : normalizeFirestoreTimestamp(row.last_mention_at),
    lifecycle_status: lifecycleStatus,
    lifecycle_last_vote_ms: Number.isFinite(row.lifecycle_last_vote_ms)
      ? Number(row.lifecycle_last_vote_ms)
      : undefined,
  };
}

export function normalizeIncidentList(value: unknown, maxRows = 2_000): Incident[] {
  if (!Array.isArray(value)) return [];
  const out: Incident[] = [];
  for (const raw of value.slice(0, maxRows)) {
    const id = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).id
      : null;
    const incident = normalizeIncidentRecord(id, raw);
    if (incident) out.push(incident);
  }
  return out;
}
