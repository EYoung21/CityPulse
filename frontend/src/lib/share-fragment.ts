export type ShareValueSource = "fragment" | "legacy-query";

export interface ShareValueResult {
  value: string;
  source: ShareValueSource;
}

function validShareValue(value: string | null, maxChars: number): value is string {
  return value !== null && value.length > 0 && value.length <= maxChars;
}

/** Build a share URL whose bearer value is kept out of the HTTP request. */
export function buildFragmentShareUrl(
  path: string,
  parameter: string,
  value: string,
  base?: string
): string {
  const origin = base || (typeof window !== "undefined" ? window.location.origin : "");
  const hash = new URLSearchParams([[parameter, value]]).toString();
  return `${origin.replace(/\/$/, "")}${path}#${hash}`;
}

/** Read the canonical fragment value, with query support for old links. */
export function shareValueFromUrl(
  url: URL,
  parameter: string,
  maxChars: number
): ShareValueResult | null {
  const hashValues = new URLSearchParams(url.hash.slice(1)).getAll(parameter);
  if (hashValues.length > 1) return null;
  if (hashValues.length === 1) {
    return validShareValue(hashValues[0], maxChars)
      ? { value: hashValues[0], source: "fragment" }
      : null;
  }

  const queryValues = url.searchParams.getAll(parameter);
  if (queryValues.length !== 1 || !validShareValue(queryValues[0], maxChars)) {
    return null;
  }
  return { value: queryValues[0], source: "legacy-query" };
}

/** Move a legacy query bearer into the fragment while preserving other state. */
export function urlWithCanonicalShareFragment(
  url: URL,
  parameter: string,
  value: string
): string {
  const cleaned = new URL(url.toString());
  cleaned.searchParams.delete(parameter);
  const hashParams = new URLSearchParams(cleaned.hash.slice(1));
  hashParams.set(parameter, value);
  cleaned.hash = hashParams.toString();
  return `${cleaned.pathname}${cleaned.search}${cleaned.hash}`;
}
