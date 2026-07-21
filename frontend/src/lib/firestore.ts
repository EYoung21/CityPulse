import {
  collection,
  documentId,
  getDocs,
  getDocsFromCache,
  limit as limitFn,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  where,
  type QuerySnapshot,
} from "firebase/firestore";
import { getFirestoreDb } from "@/lib/firebase";
import type { Incident, Extraction, IncidentPageResponse, PreprocessMeta, VariantResult, WhisperMeta } from "@/lib/api";
import { enrichIncidents } from "@/lib/incident-weights";
import {
  normalizeFiniteNumber,
  normalizeIncidentRecord,
  normalizeFirestoreTimestamp,
} from "@/lib/firestore-values";
import { getCurrentCity } from "@/lib/pulse-cities";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

const COLLECTION = "incidents";
/** Map + live listener: recent incidents for first paint + live updates. */
export const MAP_SYNC_LIMIT = 1200;
/** Default chunk size when backfilling a user-selected time window. */
export const EXTENDED_HISTORY_PAGE_SIZE = 2000;
/** Per-query page ceiling (not a session total — paging runs until the window is full). */
const EXTENDED_HISTORY_MAX_PAGE = 10_000;
const FIRESTORE_READ_TIMEOUT_MS = 10_000;
const INCIDENT_CURSOR_SEPARATOR = "\x1f";

export function getDocsWithDeadline<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  timeoutMs = FIRESTORE_READ_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error("Firestore request timed out"))),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export function encodeIncidentCursor(reportedAt: string, documentIdValue: string): string {
  return `${reportedAt}${INCIDENT_CURSOR_SEPARATOR}${documentIdValue}`;
}

export function decodeIncidentCursor(cursor?: string | null): {
  reportedAt: string;
  documentId: string;
} {
  const raw = (cursor || "").trim();
  const separatorIndex = raw.indexOf(INCIDENT_CURSOR_SEPARATOR);
  return separatorIndex >= 0
    ? {
        reportedAt: raw.slice(0, separatorIndex),
        documentId: raw.slice(separatorIndex + INCIDENT_CURSOR_SEPARATOR.length),
      }
    : { reportedAt: raw, documentId: "" };
}

function mapDoc(id: string, data: Record<string, unknown>): Incident {
  // Firestore document ids are always non-empty, so normalization can only
  // return null if the SDK hands us a non-object (which d.data() never does).
  return normalizeIncidentRecord(id, data)!;
}

/** Cheap accurate total via the server-cached /api/stats/count endpoint.
 *
 *  The server uses Firestore's count aggregation (1 read regardless of
 *  N docs) AND sets `Cache-Control: s-maxage=300` so a CDN serves most
 *  requests with zero Firestore hits per visitor. New users typically
 *  pay nothing for this count.
 *
 *  Pass `hours` (matching the global timeFilter) rather than an ISO
 *  cutoff so the endpoint URL is stable for a 5-minute window — that's
 *  what makes CDN caching effective. Times computed inside the server
 *  handler from the same hours value. */
export async function fetchIncidentCount(opts: {
  hours: number;
}): Promise<number> {
  const city = getCurrentCity().slug;
  // "All" comes through as Infinity from the TIME_FILTERS table — encode
  // as the literal "all" sentinel so the URL is well-formed and the
  // server can choose to skip the `reported_at` clause entirely.
  const hoursParam = Number.isFinite(opts.hours) ? String(opts.hours) : "all";
  const url = `/api/stats/count?city=${encodeURIComponent(city)}&hours=${hoursParam}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  // 503: Firestore aggregate index still building — same sentinel as other failures.
  if (res.status === 503) {
    return -1;
  }
  if (!res.ok) {
    throw new Error(`count endpoint returned ${res.status}`);
  }
  const raw = await readBoundedJsonResponse(res, 64 * 1024);
  const count = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).count
    : null;
  return Number.isSafeInteger(count) && (count as number) >= 0 ? count as number : -1;
}

/** One page of historical incidents in the (sinceISO, cursor?] window.
 *  Caller chains pages until `nextCursor` is null (window fully loaded)
 *  or stops early on user intent change. Each page is bounded by
 *  `pageSize` so cost is paid in chunks instead of a single megafetch.
 *
 *  Skips the `inhibitor`/`hidden`/`llm_fallback` rows the same way
 *  `subscribeIncidents` does, so the merged set stays renderable. */
function incidentsFromSnapshot(snap: QuerySnapshot): Incident[] {
  const list: Incident[] = [];
  snap.forEach((d) => {
    const row = mapDoc(d.id, d.data());
    if (shouldRenderIncident(row)) list.push(row);
  });
  return enrichIncidents(list);
}

function mapSyncQuery() {
  const db = getFirestoreDb();
  return query(
    collection(db, COLLECTION),
    where("city", "==", getCurrentCity().slug),
    orderBy("reported_at", "desc"),
    limitFn(MAP_SYNC_LIMIT),
  );
}

export async function fetchExtendedHistoryPage(opts: {
  /** Inclusive lower bound for `reported_at`. ISO string. `null` =
   *  "no lower bound" (the "All" pill). Used to STOP paging once we
   *  walk past the window, NOT included as a Firestore `where` clause
   *  — adding it would require a composite index that often isn't
   *  provisioned yet, and we already have `(city, reported_at desc)`
   *  from the live listener which is the index this query DOES use. */
  sinceISO: string | null;
  /** Previous page's opaque `nextCursor` — reported-at timestamp plus
   *  document ID. Omit on the first call. */
  cursor?: string | null;
  /** Page size; defaults to {@link EXTENDED_HISTORY_PAGE_SIZE}. */
  pageSize?: number;
}): Promise<{ rows: Incident[]; nextCursor: string | null }> {
  const db = getFirestoreDb();
  const size = Math.max(
    1,
    Math.min(opts.pageSize ?? EXTENDED_HISTORY_PAGE_SIZE, EXTENDED_HISTORY_MAX_PAGE)
  );
  // Note: NO `where("reported_at", ">=", …)` clause. Sorting desc and
  // walking the cursor is enough — once a page's last row is older than
  // `sinceISO`, we set `nextCursor = null` and stop paging.
  const clauses = [
    where("city", "==", getCurrentCity().slug),
    orderBy("reported_at", "desc"),
    orderBy(documentId(), "desc"),
  ];
  const { reportedAt: cursorAt, documentId: cursorId } = decodeIncidentCursor(
    opts.cursor,
  );
  const q = cursorAt && cursorId
    ? query(
        collection(db, COLLECTION),
        ...clauses,
        startAfter(cursorAt, cursorId),
        limitFn(size),
      )
    : cursorAt
      ? query(
          collection(db, COLLECTION),
          ...clauses,
          startAfter(cursorAt),
          limitFn(size),
        )
      : query(collection(db, COLLECTION), ...clauses, limitFn(size));
  const snap = await getDocsWithDeadline(getDocs(q));
  const list: Incident[] = [];
  let lastReportedAt: string | null = null;
  let lastDocumentId: string | null = null;
  let crossedCutoff = false;
  snap.forEach((d) => {
    const row = mapDoc(d.id, d.data());
    lastReportedAt = row.reported_at;
    lastDocumentId = d.id;
    // Stop including rows once we cross the lower bound. We still walk
    // the rest of the page so the cursor advances, but we don't keep
    // rows the user didn't ask for.
    if (opts.sinceISO && row.reported_at < opts.sinceISO) {
      crossedCutoff = true;
      return;
    }
    if (shouldRenderIncident(row)) list.push(row);
  });
  // Stop paging when (a) we got a partial page (no more data) OR (b)
  // we walked past the time window.
  const nextCursor =
    !crossedCutoff && snap.size === size && lastReportedAt && lastDocumentId
      ? encodeIncidentCursor(lastReportedAt, lastDocumentId)
      : null;
  return { rows: enrichIncidents(list), nextCursor };
}

/** Same query slice as `subscribeIncidents`, one `getDocs` read.
 *  Used to paint the map as soon as possible: `onSnapshot` can lag on
 *  cold start while this returns from cache or a single round-trip. */
export async function fetchIncidentsSnapshotOnce(): Promise<Incident[]> {
  const q = mapSyncQuery();
  try {
    const cached = await getDocsFromCache(q);
    if (!cached.empty) return incidentsFromSnapshot(cached);
  } catch {
    /* no IndexedDB cache yet */
  }
  const snap = await getDocsWithDeadline(getDocs(q));
  return incidentsFromSnapshot(snap);
}

/**
 * Live incidents for the map (non-blocked only). Caller should filter by category client-side if needed.
 */
export function subscribeIncidents(
  onData: (incidents: Incident[]) => void,
  onError?: (e: Error) => void
): () => void {
  const q = mapSyncQuery();

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
 *     Cursor contains the ISO timestamp and document ID of the last incident
 *     in the previous page, so equal timestamps cannot skip records.
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
  signal?: AbortSignal;
}): Promise<IncidentPageResponse> {
  const db = getFirestoreDb();
  const limit = opts.limit ?? 20;
  const citySlug = opts.city || getCurrentCity().slug;
  const isNear = opts.nearLat != null && opts.nearLng != null;
  const sinceIso = (opts.since || "").trim();

  if (isNear) {
    // Pull recent incidents in the city, then haversine-sort (matches API `mode=near`).
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const lowerBound = sinceIso && sinceIso > sevenDaysAgo ? sinceIso : sevenDaysAgo;
    const q = query(
      collection(db, COLLECTION),
      where("city", "==", citySlug),
      where("reported_at", ">=", lowerBound),
      orderBy("reported_at", "desc"),
      limitFn(500),
    );
    const snap = await getDocsWithDeadline(getDocs(q), opts.signal);
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

  // "recent" mode: cursor is `reported_at\x1fdocumentId` so we can
  // `startAfter` through hidden/blocked rows without stalling pagination.
  // We over-fetch raw docs, filter client-side, then still know whether
  // Firestore has more rows when the raw batch fills the cap.
  const { reportedAt: cursorAt, documentId: cursorId } = decodeIncidentCursor(
    opts.cursor,
  );

  const fetchCap = Math.min(120, Math.max(limit + 25, limit * 3));
  const baseConstraintsCompound = [
    where("city", "==", citySlug),
    ...(sinceIso ? [where("reported_at", ">=", sinceIso)] : []),
    orderBy("reported_at", "desc"),
    orderBy(documentId(), "desc"),
  ];

  let snap;
  const legacy = [
    where("city", "==", citySlug),
    ...(sinceIso ? [where("reported_at", ">=", sinceIso)] : []),
    orderBy("reported_at", "desc"),
  ];
  const runLegacy = (after?: string) =>
    getDocsWithDeadline(
      getDocs(
        after
          ? query(collection(db, COLLECTION), ...legacy, startAfter(after), limitFn(fetchCap))
          : query(collection(db, COLLECTION), ...legacy, limitFn(fetchCap))
      ),
      opts.signal,
    );

  try {
    if (cursorAt && cursorId) {
      snap = await getDocsWithDeadline(
        getDocs(
          query(
            collection(db, COLLECTION),
            ...baseConstraintsCompound,
            startAfter(cursorAt, cursorId),
            limitFn(fetchCap)
          )
        ),
        opts.signal,
      );
    } else if (cursorAt) {
      snap = await runLegacy(cursorAt);
    } else {
      snap = await getDocsWithDeadline(
        getDocs(
          query(
            collection(db, COLLECTION),
            ...baseConstraintsCompound,
            limitFn(fetchCap),
          )
        ),
        opts.signal,
      );
    }
  } catch {
    // Missing / building composite index (city, reported_at desc, __name__ desc), or
    // compound cursor unsupported — chronological `startAfter` still moves forward.
    snap = await runLegacy(cursorAt || undefined);
  }

  const visible: Incident[] = [];
  snap.forEach((doc) => {
    const inc = mapDoc(doc.id, doc.data());
    if (shouldRenderIncident(inc)) visible.push(inc);
  });

  const hasMoreInBatch = visible.length > limit;
  const page = hasMoreInBatch ? visible.slice(0, limit) : visible;
  const batchExhausted = snap.size < fetchCap;
  const hasMore = hasMoreInBatch || (!batchExhausted && snap.size > 0);

  const enriched = enrichIncidents(page);
  const last = enriched[enriched.length - 1];
  const lastRaw = snap.docs[snap.docs.length - 1];
  let next: string | null = null;
  if (hasMore) {
    if (hasMoreInBatch && last) {
      next = encodeIncidentCursor(last.reported_at, last.id);
    } else if (lastRaw) {
      const d = lastRaw.data();
      const at = normalizeFirestoreTimestamp(d.reported_at);
      next = encodeIncidentCursor(at, lastRaw.id);
    }
  }

  return {
    incidents: enriched,
    next_cursor: next,
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
    reported_at: normalizeFirestoreTimestamp(data.reported_at),
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
    llm_confidence: normalizeFiniteNumber(data.llm_confidence, 0, 0, 1),
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
  const db = getFirestoreDb();
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
  const db = getFirestoreDb();
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
