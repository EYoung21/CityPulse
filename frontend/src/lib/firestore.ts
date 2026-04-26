import {
  collection,
  getDocs,
  getFirestore,
  limit as limitFn,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  where,
} from "firebase/firestore";
import { getFirebaseApp } from "@/lib/firebase";
import type { Incident, Extraction, IncidentPageResponse, PreprocessMeta, VariantResult, WhisperMeta } from "@/lib/api";
import { enrichIncidents } from "@/lib/incident-weights";
import { getCurrentCity } from "@/lib/pulse-cities";

const COLLECTION = "incidents";
const MAX_DOCS = 5000;

function toISOString(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (typeof val === "string") {
    let s = val;
    // Treat timezone-naive ISO strings as UTC (server stores UTC without Z)
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !s.endsWith("Z") && !/[+-]\d{2}:?\d{2}$/.test(s)) {
      s += "Z";
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  if (typeof val === "object" && val !== null && "toDate" in val && typeof (val as { toDate: () => Date }).toDate === "function") {
    return (val as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof val === "object" && val !== null && "seconds" in val) {
    return new Date((val as { seconds: number }).seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

function mapDoc(id: string, data: Record<string, unknown>): Incident {
  return {
    id,
    reported_at: toISOString(data.reported_at),
    raw_text: String(data.raw_text ?? ""),
    severity_category: String(data.severity_category ?? ""),
    s_base: Number(data.s_base ?? 0),
    location_text:
      data.location_text === null || data.location_text === undefined
        ? null
        : String(data.location_text),
    lat:
      data.lat === null || data.lat === undefined ? null : Number(data.lat),
    lng:
      data.lng === null || data.lng === undefined ? null : Number(data.lng),
    confidence: Number(data.confidence ?? 1),
    geocode_status: String(data.geocode_status ?? "pending"),
    location_confidence: (["direct", "context", "none"].includes(String(data.location_confidence ?? "none"))
      ? String(data.location_confidence)
      : "none") as import("./api").LocationConfidence,
    inhibitor_status: String(data.inhibitor_status ?? "passed"),
    inhibitor_reason:
      data.inhibitor_reason === null || data.inhibitor_reason === undefined
        ? null
        : String(data.inhibitor_reason),
    w_eff: 0,
    audio_clip:
      data.audio_clip === null || data.audio_clip === undefined
        ? null
        : String(data.audio_clip),
    audio_url:
      data.audio_url === null || data.audio_url === undefined
        ? null
        : String(data.audio_url),
    feed_id:
      data.feed_id === null || data.feed_id === undefined
        ? null
        : String(data.feed_id),
    description:
      data.description === null || data.description === undefined
        ? null
        : String(data.description),
    hidden: data.hidden === true,
    word_timings: Array.isArray(data.word_timings) ? data.word_timings : null,
  };
}

/** Same query slice as `subscribeIncidents`, one `getDocs` read.
 *  Used to paint the map as soon as possible: `onSnapshot` can lag on
 *  cold start while this returns from cache or a single round-trip. */
export async function fetchIncidentsSnapshotOnce(): Promise<Incident[]> {
  const db = getFirestore(getFirebaseApp());
  const q = query(
    collection(db, COLLECTION),
    where("city", "==", getCurrentCity().slug),
    orderBy("reported_at", "desc"),
    limitFn(MAX_DOCS)
  );
  const snap = await getDocs(q);
  const list: Incident[] = [];
  snap.forEach((d) => {
    const row = mapDoc(d.id, d.data());
    if (shouldRenderIncident(row)) list.push(row);
  });
  return enrichIncidents(list);
}

/**
 * Live incidents for the map (non-blocked only). Caller should filter by category client-side if needed.
 */
export function subscribeIncidents(
  onData: (incidents: Incident[]) => void,
  onError?: (e: Error) => void
): () => void {
  const db = getFirestore(getFirebaseApp());
  const q = query(
    collection(db, COLLECTION),
    where("city", "==", getCurrentCity().slug),
    orderBy("reported_at", "desc"),
    limitFn(MAX_DOCS)
  );

  return onSnapshot(
    q,
    (snap) => {
      const list: Incident[] = [];
      snap.forEach((doc) => {
        const row = mapDoc(doc.id, doc.data());
        if (shouldRenderIncident(row)) list.push(row);
      });
      onData(enrichIncidents(list));
    },
    (err) => {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  );
}

/**
 * Centralised render gate for incidents pulled from Firestore.
 *
 * Filters out three classes of "we shouldn't be drawing this":
 *   1. Inhibitor blocked (ethics/abuse policy hit).
 *   2. Soft-hidden by the LLM-fallback repair script
 *      (`hidden === true`, `geocode_status === "unmapped_repaired"`).
 *   3. The original tainted rows from before the
 *      `incident_geocode_hallucination` fix — `geocode_status` starts
 *      with `llm_fallback`. The LLM was hallucinating the city
 *      centroid for any address Nominatim couldn't resolve, which
 *      caused thousands of unrelated incidents to pile on the same
 *      pin (the giant 1064/1498/276/71 clusters the user reported).
 *      The new ingest path no longer does this, but old data is
 *      still in Firestore. Hiding client-side is the cheapest fix
 *      while the backend repair pass is offline (see
 *      scripts/repair_llm_fallback_incidents.py).
 */
export function shouldRenderIncident(inc: Incident): boolean {
  if (inc.inhibitor_status === "blocked") return false;
  if (inc.hidden === true) return false;
  const gs = inc.geocode_status || "";
  if (gs.startsWith("llm_fallback")) return false;
  return true;
}

/**
 * Cursor-paginated incidents read directly from Firestore. Mirrors the
 * shape of `lib/api.ts > fetchIncidentPage` so the `/feed` route can
 * swap between API-backed and Firestore-backed fetches without
 * touching its render logic.
 *
 * Why duplicate the API: when the Python backend's `/api/incidents/page`
 * is unreachable (e.g. the prod uvicorn is hung on a slow LLM call),
 * the feed used to render an empty list even though the same data is
 * sitting in Firestore — which the map view reads directly via
 * `subscribeIncidents`. This keeps the feed alive end-to-end as long
 * as Firestore is reachable.
 *
 * Modes:
 *   - "recent": orderBy(reported_at desc) with cursor pagination.
 *     Cursor is the ISO timestamp of the last incident in the previous
 *     page (we use Firestore's `startAfter(value)` since we already
 *     have the doc value, no extra read).
 *   - "near": fetches a single 7-day window of recent incidents with
 *     valid coords, sorts client-side by haversine distance, returns
 *     the closest `limit`. No cursor (matches the Python endpoint's
 *     behavior; the page caller already disables infinite scroll in
 *     "near" mode).
 */
export async function fetchIncidentPageFromFirestore(opts: {
  cursor?: string | null;
  limit?: number;
  city?: string;
  nearLat?: number | null;
  nearLng?: number | null;
  since?: string;
}): Promise<IncidentPageResponse> {
  const db = getFirestore(getFirebaseApp());
  const limit = opts.limit ?? 20;
  const citySlug = opts.city || getCurrentCity().slug;
  const isNear = opts.nearLat != null && opts.nearLng != null;
  const sinceIso = (opts.since || "").trim();

  if (isNear) {
    // Pull up to 500 recent incidents in the city, then haversine-sort.
    // 7 days window keeps payload bounded; matches the server's
    // `mode=near` heuristic of "recent enough to still be useful".
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const lowerBound = sinceIso && sinceIso > sevenDaysAgo ? sinceIso : sevenDaysAgo;
    const q = query(
      collection(db, COLLECTION),
      where("city", "==", citySlug),
      where("reported_at", ">=", lowerBound),
      orderBy("reported_at", "desc"),
      limitFn(500),
    );
    const snap = await getDocs(q);
    const list: (Incident & { distance_km?: number })[] = [];
    snap.forEach((doc) => {
      const inc = mapDoc(doc.id, doc.data());
      if (!shouldRenderIncident(inc)) return;
      if (inc.lat == null || inc.lng == null) return;
      list.push(inc);
    });
    const enriched = enrichIncidents(list) as (Incident & { distance_km?: number })[];
    const lat0 = opts.nearLat as number;
    const lng0 = opts.nearLng as number;
    for (const inc of enriched) {
      inc.distance_km = haversineKm(lat0, lng0, inc.lat as number, inc.lng as number);
    }
    enriched.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
    return {
      incidents: enriched.slice(0, limit),
      next_cursor: null,
      mode: "near",
    };
  }

  // "recent" mode: cursor is the previous page's last `reported_at`.
  const baseConstraints = [
    where("city", "==", citySlug),
    ...(sinceIso ? [where("reported_at", ">=", sinceIso)] : []),
    orderBy("reported_at", "desc"),
  ];
  const q = opts.cursor
    ? query(collection(db, COLLECTION), ...baseConstraints, startAfter(opts.cursor), limitFn(limit + 1))
    : query(collection(db, COLLECTION), ...baseConstraints, limitFn(limit + 1));
  const snap = await getDocs(q);
  const rows: Incident[] = [];
  snap.forEach((doc) => {
    const inc = mapDoc(doc.id, doc.data());
    if (shouldRenderIncident(inc)) rows.push(inc);
  });
  // Over-fetch by one so we know whether to advertise a next cursor.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const enriched = enrichIncidents(page);
  const last = enriched[enriched.length - 1];
  return {
    incidents: enriched,
    next_cursor: hasMore && last ? last.reported_at : null,
    mode: "recent",
  };
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function mapVariant(v: Record<string, unknown>): VariantResult {
  return {
    name: String(v.name ?? "unknown"),
    audio_clip:
      v.audio_clip === null || v.audio_clip === undefined
        ? null
        : String(v.audio_clip),
    transcript: String(v.transcript ?? ""),
    preprocess_meta:
      v.preprocess_meta && typeof v.preprocess_meta === "object"
        ? (v.preprocess_meta as PreprocessMeta)
        : null,
    whisper_meta:
      v.whisper_meta && typeof v.whisper_meta === "object"
        ? (v.whisper_meta as WhisperMeta)
        : null,
  };
}

function mapExtraction(id: string, data: Record<string, unknown>): Extraction {
  const rawVariants = Array.isArray(data.variants) ? data.variants : [];

  return {
    id,
    feed_id: String(data.feed_id ?? "unknown"),
    raw_text: String(data.raw_text ?? ""),
    reported_at: toISOString(data.reported_at),
    audio_clip:
      data.audio_clip === null || data.audio_clip === undefined
        ? null
        : String(data.audio_clip),
    raw_audio_clip:
      data.raw_audio_clip === null || data.raw_audio_clip === undefined
        ? null
        : String(data.raw_audio_clip),
    preprocess_meta:
      data.preprocess_meta && typeof data.preprocess_meta === "object"
        ? (data.preprocess_meta as PreprocessMeta)
        : null,
    variants: rawVariants.map((v: Record<string, unknown>) => mapVariant(v)),
    llm_relevant: Boolean(data.llm_relevant),
    llm_category:
      data.llm_category === null || data.llm_category === undefined
        ? null
        : String(data.llm_category),
    llm_confidence: Number(data.llm_confidence ?? 0),
    llm_location_text:
      data.llm_location_text === null || data.llm_location_text === undefined
        ? null
        : String(data.llm_location_text),
    inhibitor_status:
      data.inhibitor_status === null || data.inhibitor_status === undefined
        ? null
        : String(data.inhibitor_status),
    inhibitor_reason:
      data.inhibitor_reason === null || data.inhibitor_reason === undefined
        ? null
        : String(data.inhibitor_reason),
    geocode_status:
      data.geocode_status === null || data.geocode_status === undefined
        ? null
        : String(data.geocode_status),
    incident_id:
      data.incident_id === null || data.incident_id === undefined
        ? null
        : String(data.incident_id),
  };
}

export function subscribeExtractions(
  feedId: string,
  since: Date,
  until: Date,
  onData: (extractions: Extraction[]) => void,
  onError?: (e: Error) => void
): () => void {
  const db = getFirestore(getFirebaseApp());
  const q = query(
    collection(db, "extractions"),
    where("feed_id", "==", feedId),
    where("reported_at", ">=", since.toISOString()),
    where("reported_at", "<=", until.toISOString()),
    orderBy("reported_at", "desc"),
    limitFn(2000)
  );

  return onSnapshot(
    q,
    (snap) => {
      const list: Extraction[] = [];
      snap.forEach((doc) => {
        list.push(mapExtraction(doc.id, doc.data()));
      });
      onData(list);
    },
    (err) => {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  );
}

export function subscribeAllExtractions(
  since: Date,
  until: Date,
  onData: (extractions: Extraction[]) => void,
  onError?: (e: Error) => void
): () => void {
  const db = getFirestore(getFirebaseApp());
  const q = query(
    collection(db, "extractions"),
    where("reported_at", ">=", since.toISOString()),
    where("reported_at", "<=", until.toISOString()),
    orderBy("reported_at", "desc"),
    limitFn(2000)
  );

  return onSnapshot(
    q,
    (snap) => {
      const list: Extraction[] = [];
      snap.forEach((doc) => {
        list.push(mapExtraction(doc.id, doc.data()));
      });
      onData(list);
    },
    (err) => {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  );
}
