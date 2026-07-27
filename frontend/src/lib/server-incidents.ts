import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  FieldPath,
  type DocumentData,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  getFirestore,
} from "firebase-admin/firestore";

export const FREE_WINDOW_SECONDS = 72 * 60 * 60;
export const CURSOR_SEPARATOR = "\x1f";
export const CITY_RE = /^[a-z][a-z0-9-]{0,40}$/;
export const INCIDENT_CATEGORIES = new Set([
  "violent_weapon",
  "violent_no_weapon",
  "shots_heard",
  "robbery",
  "burglary_in_progress",
  "medical_priority",
  "medical_other",
  "fire_hazmat",
  "traffic_crash_injury",
  "traffic_crash_no_injury",
  "disorder",
  "admin_or_noise",
]);

type Entitlement = {
  authenticated: boolean;
  isPro: boolean;
};

export type IncidentPageOptions = {
  city: string;
  since: string;
  category?: string;
  cursor?: string | null;
  limit: number;
};

export type IncidentRow = Record<string, unknown> & {
  id: string;
  reported_at?: string;
  w_eff?: number;
};

export function ensureAdmin() {
  if (getApps().length === 0) {
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (process.env.FIREBASE_ADMIN_KEY) {
      initializeApp({
        credential: cert(JSON.parse(process.env.FIREBASE_ADMIN_KEY)),
      });
    } else {
      initializeApp({ projectId });
    }
  }
  return {
    auth: getAuth(),
    db: getFirestore(),
  };
}

function timestampMillis(value: unknown): number | null {
  if (value && typeof value === "object" && "toMillis" in value) {
    const toMillis = (value as { toMillis?: unknown }).toMillis;
    if (typeof toMillis === "function") {
      const millis = Number(toMillis.call(value));
      return Number.isFinite(millis) ? millis : null;
    }
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

export async function resolveEntitlement(request: Request): Promise<Entitlement> {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return { authenticated: false, isPro: false };

  try {
    const { auth, db } = ensureAdmin();
    const decoded = await auth.verifyIdToken(match[1], true);
    const user = await db.doc(`users/${decoded.uid}`).get();
    const data = user.data() || {};
    const proUntil = timestampMillis(data.proUntil);
    return {
      authenticated: true,
      isPro:
        data.tier === "pro" ||
        (proUntil !== null && proUntil > Date.now()),
    };
  } catch {
    // Incident reads are public. An expired/malformed optional token falls
    // back to the free public window instead of taking the map offline.
    return { authenticated: false, isPro: false };
  }
}

export function canonicalIso(value: string): string | null {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString().replace(/Z$/, "+00:00");
}

export function effectiveSince(
  requested: string | null,
  isPro: boolean,
  now = Date.now(),
): { since: string; clamped: boolean } {
  const floor = new Date(now - FREE_WINDOW_SECONDS * 1_000)
    .toISOString()
    .replace(/Z$/, "+00:00");
  const parsed = requested ? canonicalIso(requested) : null;
  if (isPro) {
    return { since: parsed || floor, clamped: false };
  }
  if (!parsed || parsed < floor) {
    return { since: floor, clamped: !!requested };
  }
  return { since: parsed, clamped: false };
}

export function parseCursor(
  value: string | null,
): { timestamp: string; id: string | null } | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  const separator = raw.indexOf(CURSOR_SEPARATOR);
  const timestampRaw = separator >= 0 ? raw.slice(0, separator) : raw;
  const id = separator >= 0 ? raw.slice(separator + 1) : null;
  const timestamp = canonicalIso(timestampRaw);
  if (!timestamp) return null;
  if (id !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return null;
  return { timestamp, id };
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      const date = (value as { toDate: () => Date }).toDate();
      return date.toISOString();
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

const PUBLIC_INCIDENT_FIELDS = [
  "reported_at",
  "raw_text",
  "severity_category",
  "s_base",
  "location_text",
  "lat",
  "lng",
  "confidence",
  "geocode_status",
  "location_confidence",
  "inhibitor_status",
  "inhibitor_reason",
  "audio_clip",
  "audio_url",
  "feed_id",
  "description",
  "unit_status",
  "has_word_timings",
  "mention_count",
  "last_mention_at",
  "lifecycle_status",
  "lifecycle_last_vote_ms",
] as const;

const PUBLIC_MENTION_FIELDS = [
  "at",
  "raw_text",
  "audio_clip",
  "audio_url",
  "feed_id",
  "location_text",
  "location_confidence",
  "confidence",
  "severity_category",
  "s_base",
  "description",
] as const;

/**
 * Firestore documents may acquire private ingestion/debug fields over time.
 * API responses are fail-closed: only the reviewed public contract is copied
 * out, including explicit projections for nested arrays.
 */
export function publicIncidentData(data: DocumentData): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of PUBLIC_INCIDENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      row[field] = jsonSafe(data[field]);
    }
  }

  if (Array.isArray(data.word_timings)) {
    row.word_timings = data.word_timings.slice(0, 5_000).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const timing = value as Record<string, unknown>;
      return [{
        word: jsonSafe(timing.word),
        start: jsonSafe(timing.start),
        end: jsonSafe(timing.end),
      }];
    });
  }

  if (Array.isArray(data.mentions)) {
    row.mentions = data.mentions.slice(0, 500).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const mention = value as Record<string, unknown>;
      const projected: Record<string, unknown> = {};
      for (const field of PUBLIC_MENTION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(mention, field)) {
          projected[field] = jsonSafe(mention[field]);
        }
      }
      return [projected];
    });
  }

  return row;
}

export function enrichIncident(
  id: string,
  data: DocumentData,
  now = Date.now(),
): IncidentRow {
  const row = publicIncidentData(data);
  const reportedAt =
    typeof row.reported_at === "string" ? Date.parse(row.reported_at) : Number.NaN;
  const sBase =
    typeof row.s_base === "number" && Number.isFinite(row.s_base)
      ? Math.max(0, Math.min(1, row.s_base))
      : 0.5;
  const confidence =
    typeof row.confidence === "number" && Number.isFinite(row.confidence)
      ? Math.max(0.3, Math.min(1, row.confidence))
      : 1;
  const ageHours = Number.isFinite(reportedAt)
    ? Math.max(0, now - reportedAt) / 3_600_000
    : Number.POSITIVE_INFINITY;
  const wEff = Number.isFinite(ageHours)
    ? sBase * Math.exp(-ageHours / 12) * confidence
    : 0;
  return {
    ...row,
    id,
    w_eff: Math.round(wEff * 10_000) / 10_000,
  };
}

function isVisible(data: DocumentData): boolean {
  return data.hidden !== true && data.inhibitor_status !== "blocked";
}

export async function readIncidentPage(
  options: IncidentPageOptions,
): Promise<{ incidents: IncidentRow[]; nextCursor: string | null }> {
  const { db } = ensureAdmin();
  const cursor = parseCursor(options.cursor || null);
  let query: Query<DocumentData> = db
    .collection("incidents")
    .where("city", "==", options.city);
  if (options.category) {
    query = query.where("severity_category", "==", options.category);
  }
  query = query.where("reported_at", ">=", options.since);
  if (cursor && !cursor.id) {
    query = query.where("reported_at", "<", cursor.timestamp);
  }
  query = query
    .orderBy("reported_at", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  if (cursor?.id) {
    query = query.startAfter(cursor.timestamp, cursor.id);
  }

  const desired = Math.max(1, Math.min(options.limit, 1_200)) + 1;
  const incidents: IncidentRow[] = [];
  let scanned = 0;
  let last: QueryDocumentSnapshot<DocumentData> | null = null;
  while (incidents.length < desired && scanned < Math.max(5_000, desired * 10)) {
    const chunkSize = Math.min(250, Math.max(50, desired - incidents.length + 25));
    const pageQuery: Query<DocumentData> = last ? query.startAfter(last) : query;
    const snapshot: QuerySnapshot<DocumentData> = await pageQuery.limit(chunkSize).get();
    if (snapshot.empty) break;
    scanned += snapshot.size;
    last = snapshot.docs[snapshot.docs.length - 1];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (!isVisible(data)) continue;
      incidents.push(enrichIncident(doc.id, data));
      if (incidents.length >= desired) break;
    }
    if (snapshot.size < chunkSize) break;
  }

  const hasMore = incidents.length > options.limit;
  const page = incidents.slice(0, options.limit);
  const finalRow = hasMore ? page[page.length - 1] : null;
  const nextCursor =
    finalRow && typeof finalRow.reported_at === "string"
      ? `${finalRow.reported_at}${CURSOR_SEPARATOR}${finalRow.id}`
      : null;
  return { incidents: page, nextCursor };
}

export async function readIncidentWindow(options: {
  city: string;
  since: string;
  category?: string;
  limit?: number;
}): Promise<IncidentRow[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 1_200));
  return (
    await readIncidentPage({
      city: options.city,
      since: options.since,
      category: options.category,
      limit,
    })
  ).incidents;
}

export function incidentHeaders(
  entitlement: Entitlement,
  clamped: boolean,
): Headers {
  const headers = new Headers({
    "Cache-Control": entitlement.authenticated
      ? "private, no-store"
      : "public, s-maxage=10, stale-while-revalidate=20",
    Vary: "Authorization",
    "X-Pulse-Free-Window-Sec": String(FREE_WINDOW_SECONDS),
  });
  if (clamped) headers.set("X-Pulse-Clamped", "1");
  return headers;
}

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);
  const dLat = rLat2 - rLat1;
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;
  return 6_371.0088 * 2 * Math.asin(Math.sqrt(a));
}
