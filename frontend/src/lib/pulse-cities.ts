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
}

export const PULSE_CITIES: PulseCity[] = [
  { slug: "sf", name: "San Francisco", domain: "sfopulse.com", emoji: "🌉", lat: 37.7749, lng: -122.4194 },
  { slug: "nyc", name: "New York City", domain: "newyorkcitypulse.com", emoji: "🗽", lat: 40.7128, lng: -74.0060 },
  { slug: "philly", name: "Philadelphia", domain: "phlpulse.com", emoji: "🔔", lat: 39.9526, lng: -75.1652 },
  { slug: "chattanooga", name: "Chattanooga", domain: "423pulse.com", emoji: "⛰️", lat: 35.0456, lng: -85.3097 },
  { slug: "seattle", name: "Seattle", domain: "206pulse.com", emoji: "☕", lat: 47.6062, lng: -122.3321 },
  { slug: "frisco", name: "Frisco", domain: "fscpulse.com", emoji: "⛳", lat: 33.1507, lng: -96.8236 },
  { slug: "dallas", name: "Dallas", domain: "dalpulse.com", emoji: "🤠", lat: 32.7767, lng: -96.7970 },
];

/** Get the current city based on NEXT_PUBLIC_CITY_SLUG env var. */
export function getCurrentCity(): PulseCity {
  const slug = process.env.NEXT_PUBLIC_CITY_SLUG || "philly";
  return PULSE_CITIES.find((c) => c.slug === slug) || PULSE_CITIES[0];
}

/** Get all OTHER cities (for the nav dropdown). */
export function getOtherCities(): PulseCity[] {
  const current = getCurrentCity();
  return PULSE_CITIES.filter((c) => c.slug !== current.slug);
}
