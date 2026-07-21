const PULSE_TOKEN_PARAM = "__pulse_token";

/** Attach a cross-city auth credential in the URL fragment so it is delivered
 * to the destination browser without being sent in the HTTP request line,
 * reverse-proxy logs, analytics page URL, or referrer headers. */
export function attachPulseTokenFragment(rawUrl: string, idToken: string): string {
  const url = new URL(rawUrl);
  const hashParams = new URLSearchParams(url.hash.slice(1));
  hashParams.set(PULSE_TOKEN_PARAM, idToken);
  url.hash = hashParams.toString();
  return url.toString();
}

/** Read current fragment handoffs and legacy query-string handoffs. Query
 * support keeps links created by an older CityPulse deployment working while
 * every newly generated link uses the non-leaking fragment form. */
export function pulseTokenFromUrl(url: URL): string | null {
  const legacyQueryToken = url.searchParams.get(PULSE_TOKEN_PARAM);
  if (legacyQueryToken) return legacyQueryToken;
  return new URLSearchParams(url.hash.slice(1)).get(PULSE_TOKEN_PARAM);
}

/** Remove the one-shot credential while preserving unrelated query and hash
 * state. Returns an origin-relative value suitable for history.replaceState. */
export function urlWithoutPulseToken(url: URL): string {
  url.searchParams.delete(PULSE_TOKEN_PARAM);

  const hashParams = new URLSearchParams(url.hash.slice(1));
  if (hashParams.has(PULSE_TOKEN_PARAM)) {
    hashParams.delete(PULSE_TOKEN_PARAM);
    url.hash = hashParams.toString();
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
