import { PULSE_CITIES } from "@/lib/pulse-cities";

const KNOWN_HOSTS = new Set(
  PULSE_CITIES.flatMap((city) => [city.domain.toLowerCase(), `www.${city.domain.toLowerCase()}`])
);

function normalizedFallback(value: string | undefined): URL {
  const candidate = value?.trim() || "http://localhost:3000";
  try {
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    ) {
      return new URL(url.origin);
    }
  } catch {
    // Fall through to the deterministic local origin.
  }
  return new URL("http://localhost:3000");
}

export function configuredSiteOrigin(): string {
  return normalizedFallback(
    process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_VERCEL_URL
  ).origin;
}

/** Resolve request-host-derived absolute URLs without trusting arbitrary Host
 * headers. Known Pulse domains, the configured deployment host, and explicit
 * loopback development hosts are accepted; everything else uses the configured
 * fallback origin. */
export function trustedRequestOrigin(
  host: string | null | undefined,
  fallback = configuredSiteOrigin()
): string {
  const fallbackUrl = normalizedFallback(fallback);
  const rawHost = host?.trim();
  if (!rawHost) return fallbackUrl.origin;

  try {
    const parsed = new URL(`http://${rawHost}`);
    if (
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      return fallbackUrl.origin;
    }
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    if (isLoopback) return `http://${parsed.host}`;

    if (KNOWN_HOSTS.has(hostname) && (!parsed.port || parsed.port === "443")) {
      return `https://${hostname}`;
    }

    if (
      hostname === fallbackUrl.hostname.toLowerCase() &&
      parsed.port === fallbackUrl.port
    ) {
      return fallbackUrl.origin;
    }
  } catch {
    // Invalid host syntax falls back below.
  }
  return fallbackUrl.origin;
}
