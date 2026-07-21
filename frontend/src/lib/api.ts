import { fetchPublicApi } from "@/lib/public-api-base";
import { isFirebaseConfigured, getFirebaseApp } from "@/lib/firebase";
import { getAuth } from "firebase/auth";
import { requestUpgrade } from "@/lib/upgrade";
import { getCurrentCity } from "@/lib/pulse-cities";
import {
  normalizeFiniteNumber,
  normalizeIncidentList,
  normalizeIncidentRecord,
} from "@/lib/firestore-values";
import { readBoundedJsonResponse, readBoundedTextResponse } from "@/lib/upstream-response";

const MAX_API_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SMALL_API_JSON_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readApiJson(
  response: Response,
  maxBytes = MAX_API_JSON_BYTES,
): Promise<unknown> {
  return readBoundedJsonResponse(response, maxBytes);
}

function apiSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Dedupe concurrent token reads (e.g. `Promise.all` of fetchIncidents + fetchSummary). */
let idTokenInFlight: Promise<string | null> | null = null;
let idTokenInFlightUid: string | null = null;

export async function maybeIdToken(): Promise<string | null> {
  if (!isFirebaseConfigured()) return null;
  const auth = getAuth(getFirebaseApp());
  const u = auth.currentUser;
  if (!u || u.isAnonymous) return null;

  if (idTokenInFlight && idTokenInFlightUid === u.uid) return idTokenInFlight;

  const uid = u.uid;
  const p = (async () => {
    try {
      const cur = getAuth(getFirebaseApp()).currentUser;
      if (!cur || cur.isAnonymous || cur.uid !== uid) return null;
      return await cur.getIdToken();
    } catch {
      return null;
    }
  })();

  idTokenInFlight = p;
  idTokenInFlightUid = uid;
  p.finally(() => {
    if (idTokenInFlight === p) {
      idTokenInFlight = null;
      idTokenInFlightUid = null;
    }
  });
  return p;
}

function handleClampHeaders(res: Response, feature = "History beyond 3 days") {
  const clamped = res.headers.get("x-pulse-clamped");
  if (clamped === "1") requestUpgrade(feature);
}

export type LocationConfidence = "direct" | "context" | "none";

/** A single scanner transmission attached to an incident. The first
 *  mention created the incident; later mentions are appended by the
 *  dedup pipeline when subsequent transmissions describe the same
 *  crime (same coarse coords + category + 15-min window). */
export interface IncidentMention {
  at: string;
  raw_text: string;
  audio_clip: string | null;
  audio_url: string | null;
  feed_id: string | null;
  location_text: string | null;
  location_confidence: LocationConfidence | null;
  confidence: number;
  severity_category: string;
  s_base?: number;
  description?: string | null;
}

export interface Incident {
  id: string;
  reported_at: string;
  raw_text: string;
  severity_category: string;
  s_base: number;
  location_text: string | null;
  lat: number | null;
  lng: number | null;
  confidence: number;
  geocode_status: string;
  location_confidence: LocationConfidence;
  inhibitor_status: string;
  inhibitor_reason: string | null;
  w_eff: number;
  audio_clip: string | null;
  audio_url: string | null;
  feed_id: string | null;
  description: string | null;
  /** Responder status extracted from the scanner audio (newer incidents only):
   *  units dispatched / on scene / cleared. Absent/null when not stated. */
  unit_status?: "dispatched" | "on_scene" | "cleared" | null;
  hidden?: boolean;
  /** Per-word audio-sync timings. Kept off the map-sync payload (it was ~73%
   *  of it); present inline only on legacy/unmigrated docs. When absent and
   *  `has_word_timings` is true, the detail view lazy-loads it from
   *  `/api/incidents/{id}/timings`. */
  word_timings?: { word: string; start: number; end: number }[] | null;
  /** True when the incident has word timings available in the sidecar
   *  collection (so the detail view should lazy-fetch them). */
  has_word_timings?: boolean;
  /** Append-only log of every scanner transmission that the dedup
   *  pipeline merged into this incident. The first entry is the
   *  original dispatch; subsequent entries are follow-ups (acks,
   *  on-scene reports, suspect descriptions). When `mention_count`
   *  is 1 there's nothing useful to render — UIs should hide the
   *  Updates stack in that case. */
  mentions?: IncidentMention[];
  /** Length of `mentions`, denormalized so list rows can show an
   *  "N updates" badge without iterating the array. 0/1 = no badge. */
  mention_count?: number;
  /** ISO timestamp of the most recent appended mention, used by the
   *  feed to display "Updated 4m ago" instead of the original
   *  `reported_at` when mentions accumulate. */
  last_mention_at?: string | null;
  // (Deprecated) Community voting removed; keep optional fields for backward
  // compatibility with older stored incidents / API responses.
  lifecycle_status?: "still" | "resolved" | "unverified";
  lifecycle_last_vote_ms?: number;
}

export interface PreprocessMeta {
  vad_duration_s: number;
  norm_percentile: number | null;
  norm_level: number;
  highpass_hz: number;
  vad_aggressiveness: number | null;
}

export interface WhisperMeta {
  no_speech_prob: number;
  duration_s: number;
}

export interface VariantResult {
  name: string;
  audio_clip: string | null;
  transcript: string;
  preprocess_meta: PreprocessMeta | null;
  whisper_meta: WhisperMeta | null;
}

export interface Extraction {
  id: string;
  feed_id: string;
  raw_text: string;
  reported_at: string;
  audio_clip: string | null;
  raw_audio_clip: string | null;
  preprocess_meta: PreprocessMeta | null;
  variants: VariantResult[];
  llm_relevant: boolean;
  llm_category: string | null;
  llm_confidence: number;
  llm_location_text: string | null;
  inhibitor_status: string | null;
  inhibitor_reason: string | null;
  geocode_status: string | null;
  incident_id: string | null;
}

export interface HealthResponse {
  status: string;
  llm_configured: boolean;
  llm_provider?: string;
  llm_model?: string;
  pulse_chat_llm_configured?: boolean;
  pulse_chat_deepseek_fallback?: boolean;
  inhibitor_configured: boolean;
  incident_count: number;
}

export interface StatsResponse {
  total_incidents: number;
  inhibitor_stats: Record<string, number>;
}

export interface SummaryResponse {
  summary: string;
  incident_count: number;
}

export async function fetchIncidents(
  since?: string,
  category?: string,
  city = getCurrentCity().slug,
): Promise<Incident[]> {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (category) params.set("category", category);
  params.set("city", city);
  const qs = params.toString();
  const idToken = await maybeIdToken();
  const res = await fetchPublicApi(`/api/incidents${qs ? `?${qs}` : ""}`, {
    signal: apiSignal(undefined, 10_000),
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
  });
  handleClampHeaders(res);
  if (!res.ok) throw new Error(`Failed to fetch incidents: ${res.status}`);
  const data = await readApiJson(res);
  if (!isRecord(data) || !Array.isArray(data.incidents)) throw new Error("Malformed incidents response");
  return normalizeIncidentList(data.incidents);
}

export interface KeywordWatch {
  id: string;
  keyword: string;
  city: string;
  severityFloor: number;
  active: boolean;
  createdAtMs: number;
  lastFiredMs: number;
  lastIncidentId: string | null;
}

export interface KeywordWatchListResponse {
  watches: KeywordWatch[];
  isPro: boolean;
  maxWatches: number;
}

export function normalizeKeywordWatch(value: unknown): KeywordWatch | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim().slice(0, 500) : "";
  if (
    !id ||
    typeof value.keyword !== "string" || !value.keyword.trim() ||
    typeof value.city !== "string" || !value.city.trim()
  ) return null;
  return {
    id,
    keyword: value.keyword.trim().slice(0, 200),
    city: value.city.trim().slice(0, 100),
    severityFloor: normalizeFiniteNumber(value.severityFloor, 0, 0, 1),
    active: value.active === true,
    createdAtMs: normalizeFiniteNumber(value.createdAtMs, 0, 0, Number.MAX_SAFE_INTEGER),
    lastFiredMs: normalizeFiniteNumber(value.lastFiredMs, 0, 0, Number.MAX_SAFE_INTEGER),
    lastIncidentId: typeof value.lastIncidentId === "string" ? value.lastIncidentId.slice(0, 500) : null,
  };
}

function normalizeKeywordWatchEnvelope(value: unknown): { watch: KeywordWatch } {
  const watch = isRecord(value) ? normalizeKeywordWatch(value.watch) : null;
  if (!watch) throw new Error("Malformed keyword watch response");
  return { watch };
}

export async function listKeywordWatches(idToken: string): Promise<KeywordWatchListResponse> {
  const res = await fetchPublicApi("/api/keyword-watches", {
    signal: apiSignal(),
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error(`Failed to list keyword watches: ${res.status}`);
  const data = await readApiJson(res, MAX_SMALL_API_JSON_BYTES);
  if (!isRecord(data) || !Array.isArray(data.watches)) {
    throw new Error("Malformed keyword watch list response");
  }
  return {
    watches: data.watches.flatMap((watch) => {
      const normalized = normalizeKeywordWatch(watch);
      return normalized ? [normalized] : [];
    }).slice(0, 100),
    isPro: data.isPro === true,
    maxWatches: Math.floor(normalizeFiniteNumber(data.maxWatches, 0, 0, 100)),
  };
}

export async function createKeywordWatch(
  idToken: string,
  body: { keyword: string; city?: string; severityFloor?: number }
): Promise<{ watch: KeywordWatch }> {
  const res = await fetchPublicApi("/api/keyword-watches", {
    method: "POST",
    signal: apiSignal(),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await readBoundedTextResponse(res, 64 * 1024).catch(() => "");
    throw new Error(detail || `Failed to create keyword watch: ${res.status}`);
  }
  return normalizeKeywordWatchEnvelope(await readApiJson(res, MAX_SMALL_API_JSON_BYTES));
}

export async function updateKeywordWatch(
  idToken: string,
  watchId: string,
  body: { active?: boolean; severityFloor?: number }
): Promise<{ watch: KeywordWatch }> {
  const res = await fetchPublicApi(`/api/keyword-watches/${watchId}`, {
    method: "PATCH",
    signal: apiSignal(),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to update keyword watch: ${res.status}`);
  return normalizeKeywordWatchEnvelope(await readApiJson(res, MAX_SMALL_API_JSON_BYTES));
}

export async function deleteKeywordWatch(idToken: string, watchId: string): Promise<void> {
  const res = await fetchPublicApi(`/api/keyword-watches/${watchId}`, {
    method: "DELETE",
    signal: apiSignal(),
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error(`Failed to delete keyword watch: ${res.status}`);
}

export interface IncidentSearchResponse {
  results: Incident[];
  total: number;
  query: string;
  terms?: string[];
}

export interface IncidentPageResponse {
  incidents: (Incident & { distance_km?: number })[];
  next_cursor: string | null;
  mode: "recent" | "near";
}

/** Cursor-paginated incidents feed used by the full-screen `/feed`
 *  route. `cursor` is opaque (currently a `reported_at` ISO string)
 *  and only meaningful in "recent" mode; passing `nearLat`/`nearLng`
 *  switches the server into proximity sort. */
export async function fetchIncidentPage(opts: {
  cursor?: string | null;
  limit?: number;
  since?: string;
  category?: string;
  city?: string;
  nearLat?: number | null;
  nearLng?: number | null;
  signal?: AbortSignal;
}): Promise<IncidentPageResponse> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.since) params.set("since", opts.since);
  if (opts.category) params.set("category", opts.category);
  params.set("city", opts.city || getCurrentCity().slug);
  if (opts.nearLat != null) params.set("near_lat", String(opts.nearLat));
  if (opts.nearLng != null) params.set("near_lng", String(opts.nearLng));
  const idToken = await maybeIdToken();
  const res = await fetchPublicApi(`/api/incidents/page?${params}`, {
    signal: apiSignal(opts.signal),
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
  });
  handleClampHeaders(res);
  if (!res.ok) throw new Error(`Failed to fetch incident page: ${res.status}`);
  const data = await readApiJson(res);
  if (!isRecord(data) || !Array.isArray(data.incidents)) throw new Error("Malformed incident page response");
  const incidents: (Incident & { distance_km?: number })[] = [];
  for (const raw of data.incidents) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const source = raw as Record<string, unknown>;
    const incident = normalizeIncidentRecord(source.id, source);
    if (!incident) continue;
    const distance = normalizeFiniteNumber(source.distance_km, Number.NaN, 0);
    incidents.push(Number.isFinite(distance) ? { ...incident, distance_km: distance } : incident);
  }
  return {
    incidents,
    next_cursor: typeof data.next_cursor === "string" ? data.next_cursor.slice(0, 2_000) : null,
    mode: data.mode === "near" ? "near" : "recent",
  };
}

/** Free-text search over the scanner feed. Honors the same time
 *  window the user already set on the map (caller passes `since`),
 *  so search results stay consistent with what's drawn. */
export async function searchIncidentsApi(opts: {
  q: string;
  since?: string;
  until?: string;
  category?: string;
  limit?: number;
  city?: string;
  signal?: AbortSignal;
}): Promise<IncidentSearchResponse> {
  const params = new URLSearchParams({ q: opts.q });
  if (opts.since) params.set("since", opts.since);
  if (opts.until) params.set("until", opts.until);
  if (opts.category) params.set("category", opts.category);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  params.set("city", opts.city || getCurrentCity().slug);
  const idToken = await maybeIdToken();
  const res = await fetchPublicApi(`/api/incidents/search?${params}`, {
    signal: apiSignal(opts.signal),
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
  });
  handleClampHeaders(res);
  if (!res.ok) throw new Error(`Incident search failed: ${res.status}`);
  const data = await readApiJson(res);
  if (!isRecord(data) || !Array.isArray(data.results)) throw new Error("Malformed incident search response");
  return {
    results: normalizeIncidentList(data.results),
    total: Math.max(0, Math.floor(normalizeFiniteNumber(data.total, 0, 0, 1_000_000))),
    query: typeof data.query === "string" ? data.query.slice(0, 500) : opts.q,
    terms: Array.isArray(data.terms)
      ? data.terms.filter((term): term is string => typeof term === "string").slice(0, 100)
      : undefined,
  };
}

export async function fetchSummary(city = getCurrentCity().slug): Promise<SummaryResponse> {
  const idToken = await maybeIdToken();
  const params = new URLSearchParams({ city });
  const res = await fetchPublicApi(`/api/summary?${params}`, {
    signal: apiSignal(undefined, 10_000),
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
  });
  handleClampHeaders(res);
  if (!res.ok) throw new Error(`Failed to fetch summary: ${res.status}`);
  const data = await readApiJson(res, MAX_SMALL_API_JSON_BYTES);
  if (!isRecord(data) || typeof data.summary !== "string") {
    throw new Error("Malformed summary response");
  }
  return {
    summary: data.summary.slice(0, 100_000),
    incident_count: Math.floor(normalizeFiniteNumber(data.incident_count, 0, 0, 1_000_000)),
  };
}

/** Pro-only Ask Pulse chat (Lambda via server RAG over incidents). */
export type PulseChatRole = "user" | "assistant";

export interface PulseChatMessage {
  role: PulseChatRole;
  content: string;
}

export interface PulseChatCitation {
  id: string;
  reported_at?: string | null;
  category?: string | null;
}

export interface PulseChatResponse {
  reply: string;
  citations: PulseChatCitation[];
  /** Full incident rows for the ids the reply cites (inline-card markers
   *  `[[INC:<id>]]` in `reply` map to these), in first-cited order. */
  cited_incidents?: Incident[];
  meta: {
    city: string;
    effective_since?: string | null;
    incidents_in_context: number;
    incidents_fetched: number;
    truncated: boolean;
    fetch_cap?: number;
    topic_boost?: string | null;
    tools_enabled?: boolean;
    tool_rounds?: number;
    firestore_tool_fetches?: number;
    pool_incidents?: number;
  };
}

export function normalizePulseChatResponse(value: unknown): PulseChatResponse {
  if (!isRecord(value) || typeof value.reply !== "string") {
    throw new Error("Malformed Ask Pulse response");
  }
  const meta = isRecord(value.meta) ? value.meta : {};
  const optionalCount = (raw: unknown): number | undefined =>
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.floor(Math.max(0, Math.min(1_000_000, raw)))
      : undefined;
  const citations = Array.isArray(value.citations)
    ? value.citations.flatMap((citation): PulseChatCitation[] => {
        if (!isRecord(citation) || typeof citation.id !== "string" || !citation.id) return [];
        return [{
          id: citation.id.slice(0, 500),
          reported_at: typeof citation.reported_at === "string" ? citation.reported_at.slice(0, 100) : null,
          category: typeof citation.category === "string" ? citation.category.slice(0, 100) : null,
        }];
      }).slice(0, 100)
    : [];
  return {
    reply: value.reply.slice(0, 100_000),
    citations,
    cited_incidents: Array.isArray(value.cited_incidents)
      ? normalizeIncidentList(value.cited_incidents).slice(0, 100)
      : undefined,
    meta: {
      city: typeof meta.city === "string" ? meta.city.slice(0, 100) : getCurrentCity().slug,
      effective_since: typeof meta.effective_since === "string" ? meta.effective_since.slice(0, 100) : null,
      incidents_in_context: optionalCount(meta.incidents_in_context) ?? 0,
      incidents_fetched: optionalCount(meta.incidents_fetched) ?? 0,
      truncated: meta.truncated === true,
      fetch_cap: optionalCount(meta.fetch_cap),
      topic_boost: typeof meta.topic_boost === "string" ? meta.topic_boost.slice(0, 200) : null,
      tools_enabled: typeof meta.tools_enabled === "boolean" ? meta.tools_enabled : undefined,
      tool_rounds: optionalCount(meta.tool_rounds),
      firestore_tool_fetches: optionalCount(meta.firestore_tool_fetches),
      pool_incidents: optionalCount(meta.pool_incidents),
    },
  };
}

export async function fetchPulseChat(opts: {
  messages: PulseChatMessage[];
  city?: string;
  since?: string | null;
  signal?: AbortSignal;
}): Promise<PulseChatResponse> {
  const idToken = await maybeIdToken();
  if (!idToken) {
    throw new Error("Sign in with a CityPulse account to use Ask Pulse.");
  }
  const res = await fetchPublicApi("/api/pulse-chat", {
    method: "POST",
    signal: apiSignal(opts.signal, 60_000),
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      city: opts.city,
      since: opts.since ?? undefined,
      messages: opts.messages,
    }),
  });
  handleClampHeaders(res);
  if (res.status === 401) {
    throw new Error("Session expired; sign in again.");
  }
  if (res.status === 403) {
    throw new Error("CityPulse Pro is required for Ask Pulse.");
  }
  if (res.status === 429) {
    throw new Error("Too many Ask Pulse requests. Try again shortly.");
  }
  if (!res.ok) {
    let detail = `Ask Pulse failed (${res.status})`;
    try {
      const j = await readApiJson(res, MAX_SMALL_API_JSON_BYTES);
      if (isRecord(j) && j.detail != null) {
        detail = typeof j.detail === "string" ? j.detail.slice(0, 2_000) : JSON.stringify(j.detail).slice(0, 2_000);
      }
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return normalizePulseChatResponse(await readApiJson(res, 4 * 1024 * 1024));
}

export async function fetchStats(city = getCurrentCity().slug): Promise<StatsResponse> {
  const params = new URLSearchParams({ city });
  const res = await fetchPublicApi(`/api/stats?${params}`, { signal: apiSignal(undefined, 10_000) });
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
  const data = await readApiJson(res, MAX_SMALL_API_JSON_BYTES);
  if (!isRecord(data)) throw new Error("Malformed stats response");
  const inhibitor_stats: Record<string, number> = {};
  if (isRecord(data.inhibitor_stats)) {
    for (const [key, raw] of Object.entries(data.inhibitor_stats).slice(0, 100)) {
      inhibitor_stats[key.slice(0, 100)] = normalizeFiniteNumber(raw, 0, 0, 1_000_000);
    }
  }
  return {
    total_incidents: Math.floor(normalizeFiniteNumber(data.total_incidents, 0, 0, 1_000_000)),
    inhibitor_stats,
  };
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetchPublicApi("/api/health", { signal: apiSignal(undefined, 10_000) });
  if (!res.ok) throw new Error(`Failed to fetch health: ${res.status}`);
  const data = await readApiJson(res, MAX_SMALL_API_JSON_BYTES);
  if (!isRecord(data) || typeof data.status !== "string") {
    throw new Error("Malformed health response");
  }
  return {
    status: data.status.slice(0, 100),
    llm_configured: data.llm_configured === true,
    llm_provider: typeof data.llm_provider === "string" ? data.llm_provider.slice(0, 100) : undefined,
    llm_model: typeof data.llm_model === "string" ? data.llm_model.slice(0, 200) : undefined,
    pulse_chat_llm_configured: typeof data.pulse_chat_llm_configured === "boolean" ? data.pulse_chat_llm_configured : undefined,
    pulse_chat_deepseek_fallback: typeof data.pulse_chat_deepseek_fallback === "boolean" ? data.pulse_chat_deepseek_fallback : undefined,
    inhibitor_configured: data.inhibitor_configured === true,
    incident_count: Math.floor(normalizeFiniteNumber(data.incident_count, 0, 0, 1_000_000)),
  };
}

export async function simulateIncident(): Promise<unknown> {
  const idToken = await maybeIdToken();
  const res = await fetchPublicApi("/api/simulate", {
    method: "POST",
    signal: apiSignal(undefined, 30_000),
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
  });
  if (!res.ok) throw new Error(`Simulate failed: ${res.status}`);
  return readApiJson(res, MAX_SMALL_API_JSON_BYTES);
}

export async function seedDemoData(): Promise<{ status: string; count: number }> {
  const idToken = await maybeIdToken();
  const res = await fetchPublicApi("/api/seed", {
    method: "POST",
    signal: apiSignal(undefined, 30_000),
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
  });
  if (!res.ok) throw new Error(`Seed failed: ${res.status}`);
  const data = await readApiJson(res, MAX_SMALL_API_JSON_BYTES);
  if (!isRecord(data) || typeof data.status !== "string") {
    throw new Error("Malformed seed response");
  }
  return {
    status: data.status.slice(0, 100),
    count: Math.floor(normalizeFiniteNumber(data.count, 0, 0, 1_000_000)),
  };
}
