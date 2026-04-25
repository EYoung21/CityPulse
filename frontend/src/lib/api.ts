const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

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
  hidden?: boolean;
  word_timings?: { word: string; start: number; end: number }[] | null;
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
  category?: string
): Promise<Incident[]> {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (category) params.set("category", category);
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/api/incidents${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch incidents: ${res.status}`);
  const data = await res.json();
  return data.incidents;
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

export async function listKeywordWatches(idToken: string): Promise<KeywordWatchListResponse> {
  const res = await fetch(`${API_BASE}/api/keyword-watches`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error(`Failed to list keyword watches: ${res.status}`);
  return res.json();
}

export async function createKeywordWatch(
  idToken: string,
  body: { keyword: string; city?: string; severityFloor?: number }
): Promise<{ watch: KeywordWatch }> {
  const res = await fetch(`${API_BASE}/api/keyword-watches`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `Failed to create keyword watch: ${res.status}`);
  }
  return res.json();
}

export async function updateKeywordWatch(
  idToken: string,
  watchId: string,
  body: { active?: boolean; severityFloor?: number }
): Promise<{ watch: KeywordWatch }> {
  const res = await fetch(`${API_BASE}/api/keyword-watches/${watchId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to update keyword watch: ${res.status}`);
  return res.json();
}

export async function deleteKeywordWatch(idToken: string, watchId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/keyword-watches/${watchId}`, {
    method: "DELETE",
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
  if (opts.city) params.set("city", opts.city);
  if (opts.nearLat != null) params.set("near_lat", String(opts.nearLat));
  if (opts.nearLng != null) params.set("near_lng", String(opts.nearLng));
  const res = await fetch(`${API_BASE}/api/incidents/page?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`Failed to fetch incident page: ${res.status}`);
  return res.json();
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
  if (opts.city) params.set("city", opts.city);
  const res = await fetch(`${API_BASE}/api/incidents/search?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`Incident search failed: ${res.status}`);
  return (await res.json()) as IncidentSearchResponse;
}

export async function fetchSummary(): Promise<SummaryResponse> {
  const res = await fetch(`${API_BASE}/api/summary`);
  if (!res.ok) throw new Error(`Failed to fetch summary: ${res.status}`);
  return res.json();
}

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
  return res.json();
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/api/health`);
  if (!res.ok) throw new Error(`Failed to fetch health: ${res.status}`);
  return res.json();
}

export async function simulateIncident(): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/simulate`, { method: "POST" });
  if (!res.ok) throw new Error(`Simulate failed: ${res.status}`);
  return res.json();
}

export async function seedDemoData(): Promise<{ status: string; count: number }> {
  const res = await fetch(`${API_BASE}/api/seed`, { method: "POST" });
  if (!res.ok) throw new Error(`Seed failed: ${res.status}`);
  return res.json();
}
