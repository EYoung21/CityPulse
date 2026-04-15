/**
 * Pulse Network — shared city registry.
 *
 * Single source of truth for all Pulse cities. Adding a new city means
 * adding one entry here; the PulseNetworkNav updates everywhere
 * automatically.
 */

export interface PulseCity {
  slug: string;
  name: string;
  domain: string;
  emoji: string;
  lat: number;
  lng: number;
  /**
   * Nominatim `viewbox`: left,top,right,bottom (min lon, max lat, max lon, min lat).
   */
  nominatimViewbox: string;
  /** Appended to address searches, e.g. ", San Francisco, CA" */
  geocodeSuffix: string;
}

export const PULSE_CITIES: PulseCity[] = [
  {
    slug: "sf",
    name: "San Francisco",
    domain: "sfopulse.com",
    emoji: "🌉",
    lat: 37.7749,
    lng: -122.4194,
    nominatimViewbox: "-122.52,37.81,-122.36,37.70",
    geocodeSuffix: ", San Francisco, CA",
  },
  {
    slug: "nyc",
    name: "New York City",
    domain: "newyorkcitypulse.com",
    emoji: "🗽",
    lat: 40.7128,
    lng: -74.006,
    nominatimViewbox: "-74.26,40.92,-73.70,40.49",
    geocodeSuffix: ", New York, NY",
  },
  {
    slug: "philly",
    name: "Philadelphia",
    domain: "phlpulse.com",
    emoji: "🔔",
    lat: 39.9526,
    lng: -75.1652,
    nominatimViewbox: "-75.28,40.14,-74.96,39.87",
    geocodeSuffix: ", Philadelphia, PA",
  },
  {
    slug: "chattanooga",
    name: "Chattanooga",
    domain: "423pulse.com",
    emoji: "⛰️",
    lat: 35.0456,
    lng: -85.3097,
    nominatimViewbox: "-85.50,35.20,-85.10,34.90",
    geocodeSuffix: ", Chattanooga, TN",
  },
  {
    slug: "seattle",
    name: "Seattle",
    domain: "206pulse.com",
    emoji: "☕",
    lat: 47.6062,
    lng: -122.3321,
    nominatimViewbox: "-122.45,47.72,-122.25,47.55",
    geocodeSuffix: ", Seattle, WA",
  },
  {
    slug: "frisco",
    name: "Frisco",
    domain: "fscpulse.com",
    emoji: "⛳",
    lat: 33.1507,
    lng: -96.8236,
    nominatimViewbox: "-96.95,33.22,-96.72,33.08",
    geocodeSuffix: ", Frisco, TX",
  },
  {
    slug: "dallas",
    name: "Dallas",
    domain: "dalpulse.com",
    emoji: "🤠",
    lat: 32.7767,
    lng: -96.797,
    nominatimViewbox: "-97.05,32.90,-96.65,32.68",
    geocodeSuffix: ", Dallas, TX",
  },
];

/**
 * Resolve deploy target: env slug first, then production hostname (when env is missing),
 * then Philadelphia as default for local dev.
 */
export function getCurrentCity(): PulseCity {
  const slug = process.env.NEXT_PUBLIC_CITY_SLUG?.trim();
  if (slug) {
    const bySlug = PULSE_CITIES.find((c) => c.slug === slug);
    if (bySlug) return bySlug;
  }
  if (typeof window !== "undefined") {
    const host = window.location.hostname.toLowerCase().replace(/^www\./, "");
    const byDomain = PULSE_CITIES.find((c) => c.domain.toLowerCase() === host);
    if (byDomain) return byDomain;
  }
  return PULSE_CITIES.find((c) => c.slug === "philly")!;
}

/** Get all OTHER cities (for the nav dropdown). */
export function getOtherCities(): PulseCity[] {
  const current = getCurrentCity();
  return PULSE_CITIES.filter((c) => c.slug !== current.slug);
}
