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
  const explicit = (process.env.NEXT_PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  if (typeof window === "undefined") return explicit;
  if (!explicit) return "";
  const proto = window.location.protocol;
  if (proto === "capacitor:" || proto === "ionic:") return explicit;
  try {
    if (new URL(explicit).origin === window.location.origin) return explicit;
    return "";
  } catch {
    return explicit;
  }
}

/** The explicitly configured public API base (never same-origin rewritten). */
export function getExplicitPublicApiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || "").trim().replace(/\/$/, "");
}

/** Absolute API URL or same-origin path (leading `/`). */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = getPublicApiBase();
  return base ? `${base}${p}` : p;
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
  const clip = inc.audio_clip?.trim();
  if (clip) return apiUrl(`/api/audio/${clip}`);
  const u = inc.audio_url?.trim();
  return u || null;
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
 * Same-origin **502/503/504** from the edge proxy also triggers one retry to
 * the explicit API when it differs from the primary URL — common when the
 * Python backend is slow or the proxy flakes on cold start, and it restores
 * `/api/incidents` and `/api/audio/*` without waiting for the next poll.
 */
export async function fetchPublicApi(path: string, init?: RequestInit): Promise<Response> {
  const p = path.startsWith("/") ? path : `/${path}`;
  const primary = apiUrl(p);
  const explicitBase = getExplicitPublicApiBase();
  const explicitUrl = explicitBase ? `${explicitBase}${p}` : "";
  const canFallback = Boolean(explicitUrl && primary !== explicitUrl);

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
