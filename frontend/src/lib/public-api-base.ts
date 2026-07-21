import { PULSE_CITIES } from "@/lib/pulse-cities";
import { normalizeHttpUrl } from "@/lib/safe-url";
import { normalizeWordTimings } from "@/lib/firestore-values";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

function normalizeApiBase(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return "";
    }
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return "";
  }
}

/** Apex hostnames for Pulse marketing sites that share `api.phlpulse.com`.
 * Used so a Vercel 502 on same-origin `/api/*` can retry the public API
 * (CORS is open on the FastAPI host). Includes short aliases not in the
 * city registry (e.g. `nycpulse.com` → NYC). */
function pulseMarketingApexHosts(): Set<string> {
  const s = new Set<string>(["nycpulse.com"]);
  for (const c of PULSE_CITIES) {
    const d = c.domain?.trim().toLowerCase().replace(/^www\./, "");
    if (d) s.add(d);
  }
  return s;
}

let _pulseApexCache: Set<string> | null = null;
function getPulseMarketingApexHosts(): Set<string> {
  if (!_pulseApexCache) _pulseApexCache = pulseMarketingApexHosts();
  return _pulseApexCache;
}

/** Resolve the base URL for Python API calls from the browser.
 *
 * When `NEXT_PUBLIC_API_URL` points at a *different origin* than the page
 * (e.g. `https://api.phlpulse.com` while the app is on `https://www.phlpulse.com`),
 * return `""` so `fetch("/api/...")` stays **same-origin** and Next.js
 * `rewrites` (`BACKEND_URL`) proxy to the backend — avoiding browser CORS.
 *
 * Capacitor / Ionic builds have no Next proxy; keep the explicit URL.
 */
export function getPublicApiBase(): string {
  const explicit = normalizeApiBase(process.env.NEXT_PUBLIC_API_URL);
  if (typeof window === "undefined") return explicit;
  if (!explicit) return "";
  const proto = window.location.protocol;
  if (proto === "capacitor:" || proto === "ionic:") return explicit;
  try {
    if (new URL(explicit).origin === window.location.origin) return explicit;
    return "";
  } catch {
    return "";
  }
}

/** The explicitly configured public API base (never same-origin rewritten). */
export function getExplicitPublicApiBase(): string {
  return normalizeApiBase(process.env.NEXT_PUBLIC_API_URL);
}

const SHARED_PROD_API = "https://api.phlpulse.com";

/** Env `NEXT_PUBLIC_API_URL`, or the shared prod API when the page is on a
 * known Pulse city domain (covers Vercel projects missing that env var). */
function effectivePublicApiBase(): string {
  const fromEnv = getExplicitPublicApiBase();
  if (fromEnv) return fromEnv;
  if (typeof window === "undefined") return "";
  const host = window.location.hostname.toLowerCase();
  const apex = host.replace(/^www\./, "");
  if (host === "phlpulse.com" || host.endsWith(".phlpulse.com"))
    return SHARED_PROD_API;
  if (getPulseMarketingApexHosts().has(apex)) return SHARED_PROD_API;
  return "";
}

/** Absolute API URL or same-origin path (leading `/`). */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = getPublicApiBase();
  return base ? `${base}${p}` : p;
}

/**
 * If `url` is a Firebase / GCS object URL for a clip under `audio/{id}.wav`,
 * return the 12-char hex clip id (lowercase). Otherwise null.
 *
 * Used so `fetch()` + `decodeAudioData` never hits `storage.googleapis.com`
 * directly from Pulse city origins — those responses omit CORS headers.
 */
export function storageAudioUrlToClipId(url: string): string | null {
  const s = url.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.hostname === "storage.googleapis.com") {
      const m = u.pathname.match(/\/[^/]+\/audio\/([a-f0-9]{12})\.wav$/i);
      if (m) return m[1].toLowerCase();
    }
    if (u.hostname === "firebasestorage.googleapis.com") {
      const mPath = u.pathname.match(/^\/v0\/b\/[^/]+\/o\/(.+)$/i);
      if (mPath) {
        const decoded = decodeURIComponent(mPath[1].replace(/\+/g, " "));
        const m = decoded.match(/^audio\/([a-f0-9]{12})\.wav$/i);
        if (m) return m[1].toLowerCase();
      }
    }
  } catch {
    return null;
  }
  return null;
}

function appendClipProxyCandidates(out: string[], clipId: string): void {
  if (!/^[a-f0-9]{12}$/i.test(clipId)) return;
  const id = clipId.toLowerCase();
  const path = `/api/audio/${id}`;
  const sameOrigin = apiUrl(path);
  if (!out.includes(sameOrigin)) out.push(sameOrigin);
  if (typeof window !== "undefined") {
    const explicit = effectivePublicApiBase();
    if (explicit && crossOriginFallbackAllowed(explicit)) {
      try {
        if (new URL(explicit).origin !== window.location.origin) {
          const crossOrigin = `${explicit}${path}`;
          if (crossOrigin !== sameOrigin && !out.includes(crossOrigin)) out.push(crossOrigin);
        }
      } catch {
        /* ignore */
      }
    }
  }
}

/** URL to play an incident clip in the browser (same-origin when possible).
 *
 * Prefer ``/api/audio/{clip}`` over a bare ``audio_url`` pointing at GCS: the
 * waveform player uses ``fetch()`` + ``decodeAudioData``, which fails CORS when
 * the API responds with a redirect to ``storage.googleapis.com``.
 */
export function incidentAudioSrc(inc: {
  audio_clip?: string | null;
  audio_url?: string | null;
}): string | null {
  const sources = incidentAudioSources(inc);
  return sources[0] ?? null;
}

/** All audio source URLs we know about for an incident, in priority
 *  order. The waveform player should try them sequentially until one
 *  resolves — when the backend is unhealthy and the cross-origin
 *  `/api/audio/{clip}` flow times out, this gives us at least the
 *  raw `audio_url` (typically a direct GCS link) as a working fallback.
 *
 *  Order:
 *    1. Same-origin `/api/audio/{clip}` — routed through Next rewrite;
 *       benefits from `fetchPublicApi`'s 404/502 fallback logic, and
 *       avoids CORS preflight on healthy stacks.
 *    2. Cross-origin `${effectivePublicApiBase()}/api/audio/{clip}` —
 *       direct hit on the explicit API host, side-steps any local
 *       proxy/rewrite confusion. Only included on Pulse origins where
 *       CORS is permitted.
 *    3. Raw `audio_url` — last resort for signed or third-party URLs. Rows
 *       whose `audio_url` is our public GCS path get `/api/audio/{clip}`
 *       candidates derived from that URL *before* the raw link so
 *       `fetch()` never depends on Storage CORS.
 */
export function incidentAudioSources(inc: {
  audio_clip?: string | null;
  audio_url?: string | null;
}): string[] {
  const out: string[] = [];
  const clip = inc.audio_clip?.trim();
  if (clip) appendClipProxyCandidates(out, clip);

  const u = normalizeHttpUrl(inc.audio_url);
  if (u) {
    const fromStorage = storageAudioUrlToClipId(u);
    if (fromStorage && fromStorage !== clip?.toLowerCase()) {
      appendClipProxyCandidates(out, fromStorage);
    }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** Fetch a Python API endpoint with a safe fallback.
 *
 * Primary behavior uses `apiUrl(path)` so browser calls stay same-origin and
 * leverage Next.js rewrites to avoid CORS.
 *
 * If the deployment is missing rewrites (common on new domains / mis-set
 * BACKEND_URL) those same-origin `/api/*` requests return 404. In that case
 * (or if the request throws), we retry once against the explicit
 * `NEXT_PUBLIC_API_URL` base if configured.
 *
 * Same-origin **502/503/504** can trigger one retry to the explicit API only
 * when that retry is **CORS-safe** (known Pulse marketing domains → api.phlpulse.com).
 * Other origins skip cross-origin retry unless they are known Pulse city
 * domains that share `api.phlpulse.com` (CORS on that API allows browser reads).
 */
export async function fetchPublicApi(path: string, init?: RequestInit): Promise<Response> {
  const p = path.startsWith("/") ? path : `/${path}`;
  const primary = apiUrl(p);
  const explicitBase = effectivePublicApiBase();
  const explicitUrl = explicitBase ? `${explicitBase}${p}` : "";
  const canFallback =
    Boolean(explicitUrl && primary !== explicitUrl) &&
    crossOriginFallbackAllowed(explicitBase);

  try {
    const res = await fetch(primary, init);
    if (res.status === 404 && canFallback) {
      return await fetch(explicitUrl, init);
    }
    if (
      canFallback &&
      (res.status === 502 || res.status === 503 || res.status === 504)
    ) {
      const fb = await fetch(explicitUrl, init);
      if (fb.ok) return fb;
      if (fb.status === 404) return fb;
    }
    return res;
  } catch (e) {
    if (!canFallback) throw e;
    return await fetch(explicitUrl, init);
  }
}

/** Cross-origin retry to `NEXT_PUBLIC_API_URL` when the explicit base is
 * `https://api.phlpulse.com` and the page is served from a known Pulse city
 * domain (or `*.phlpulse.com`). The shared FastAPI stack uses permissive CORS. */
function crossOriginFallbackAllowed(explicitBase: string): boolean {
  if (typeof window === "undefined") return true;
  const raw = explicitBase.trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.origin === window.location.origin) return true;
    if (u.hostname.toLowerCase() !== "api.phlpulse.com") return false;

    const host = window.location.hostname.toLowerCase();
    if (host === "phlpulse.com" || host.endsWith(".phlpulse.com")) return true;

    const apex = host.replace(/^www\./, "");
    return getPulseMarketingApexHosts().has(apex);
  } catch {
    return false;
  }
}

/** `fetch(url)` but same-origin `/api/*` URLs go through `fetchPublicApi` so
 * 404/502 fallbacks (and CORS-safe same-origin first hop) match `fetchIncidents`
 * and other API helpers. Use for waveform `arrayBuffer()` loads and similar.
 */
export async function fetchUrlWithPublicApiFallback(
  url: string,
  init?: RequestInit
): Promise<Response> {
  if (typeof window === "undefined") {
    return await fetch(url, init);
  }
  const gcsClip = storageAudioUrlToClipId(url);
  if (gcsClip) {
    return await fetchPublicApi(`/api/audio/${gcsClip}`, init);
  }
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin === window.location.origin && u.pathname.startsWith("/api/")) {
      return await fetchPublicApi(u.pathname + u.search, init);
    }
  } catch {
    /* fall through */
  }
  return await fetch(url, init);
}

/** Lazy-load an incident's per-word audio-sync timings. They're kept off the
 *  map-sync payload (≈73% of it) and fetched on demand when a detail view
 *  opens. Returns null on any failure — the player still renders the
 *  transcript, just without per-word highlight. */
export async function fetchIncidentWordTimings(
  incidentId: string,
): Promise<{ word: string; start: number; end: number }[] | null> {
  try {
    const r = await fetchPublicApi(
      `/api/incidents/${encodeURIComponent(incidentId)}/timings`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    const j = await readBoundedJsonResponse(r, 4 * 1024 * 1024);
    return normalizeWordTimings(
      j && typeof j === "object" && !Array.isArray(j)
        ? (j as Record<string, unknown>).word_timings
        : null
    );
  } catch {
    return null;
  }
}
