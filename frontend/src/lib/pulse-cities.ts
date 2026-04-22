/**
 * Pulse Network — shared city registry.
 *
 * Single source of truth for all Pulse cities. Adding a new city means
 * adding one entry here; the PulseNetworkNav updates everywhere
 * automatically.
 */

export type GridStyle =
  | "sf-diagonal" // regular grid + Market St diagonal, bay curve
  | "nyc-manhattan" // strict Manhattan grid + Broadway diagonal + twin rivers
  | "philly-penn" // William Penn's 4-square grid + two rivers
  | "chattanooga-bend"; // looser grid + Tennessee River bend

/** Point in normalized canvas space, 0..1 on each axis. */
export type NormPoint = [number, number];

export interface WaterFeature {
  kind: "river" | "bay";
  /** Polyline / polygon in normalized [0..1] canvas space. */
  path: NormPoint[];
  /** Render as filled polygon (bay) or stroked line (river). */
  filled?: boolean;
  /** Stroke/fill width relative to canvas (0..1). */
  width?: number;
}

/** A demo origin→destination pair shown on the SafeRouteSection. */
export interface RouteDemoPair {
  /** "Fishtown", "Mission" — short neighborhood-y name. */
  from: string;
  to: string;
  /** ETA of the fastest (riskier) route, shown on the picker card. */
  fastestMin: number;
  /** ETA of the safer detour route. Usually 2–4 minutes longer. */
  saferMin: number;
  /** Number of nearby incidents on the fastest route corridor. */
  hotCount: number;
}

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

  /* ── Landing-page metadata ─────────────────────────────── */
  /** City-specific brand name (e.g. "PhillyPulse"). */
  brand: string;
  /** Tagline shown under the hero title. */
  tagline: string;
  /** Accent color in "r, g, b" format (used in rgba()). */
  accentRgb: string;
  /** Secondary accent for two-tone gradients, "r, g, b". */
  accentRgb2: string;
  /** Human population string ("1.58M", "8.3M"). */
  population: string;
  /** Approximate land area in square miles. */
  areaSqMi: number;
  /** Notable neighborhoods rendered as hero stats. */
  neighborhoods: string[];
  /** Characteristic grid pattern (retained for future procedural visuals). */
  gridStyle: GridStyle;
  /** Characteristic water features (rivers, bays). */
  water: WaterFeature[];
  /** Number of police-radio / scanner feeds we listen to here. */
  scannerFeeds: number;
  /** Example origin→destination pairs cycled through the landing-page
   *  SafeRouteSection to demo the safer-routing pitch. 2–3 per city. */
  routeDemoPairs: RouteDemoPair[];
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
    brand: "SFPulse",
    tagline: "Real-time safety intelligence for the Bay.",
    // Golden Gate orange-red
    accentRgb: "255, 128, 70",
    accentRgb2: "255, 184, 110",
    population: "808K",
    areaSqMi: 47,
    neighborhoods: [
      "Mission",
      "SoMa",
      "Castro",
      "Haight",
      "Tenderloin",
      "North Beach",
      "Richmond",
      "Sunset",
    ],
    gridStyle: "sf-diagonal",
    water: [
      // Bay (northeast fill) — rough polygon hugging the coast
      {
        kind: "bay",
        filled: true,
        path: [
          [0.62, 0.0],
          [1.0, 0.0],
          [1.0, 0.85],
          [0.9, 0.92],
          [0.78, 0.78],
          [0.72, 0.58],
          [0.68, 0.35],
        ],
      },
    ],
    scannerFeeds: 14,
    routeDemoPairs: [
      { from: "Mission", to: "SoMa", fastestMin: 14, saferMin: 17, hotCount: 3 },
      { from: "Castro", to: "Financial District", fastestMin: 18, saferMin: 21, hotCount: 2 },
      { from: "Richmond", to: "North Beach", fastestMin: 22, saferMin: 25, hotCount: 4 },
    ],
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
    brand: "NYCPulse",
    tagline: "Real-time safety intelligence for the five boroughs.",
    // Taxi yellow
    accentRgb: "255, 204, 0",
    accentRgb2: "255, 232, 120",
    population: "8.3M",
    areaSqMi: 302,
    neighborhoods: [
      "Midtown",
      "Harlem",
      "LES",
      "SoHo",
      "Williamsburg",
      "Bushwick",
      "Astoria",
      "Bronx",
    ],
    gridStyle: "nyc-manhattan",
    water: [
      // Hudson (left)
      {
        kind: "river",
        path: [
          [0.2, 0.0],
          [0.22, 0.3],
          [0.2, 0.65],
          [0.18, 1.0],
        ],
        width: 0.04,
      },
      // East River (right)
      {
        kind: "river",
        path: [
          [0.78, 0.0],
          [0.74, 0.35],
          [0.78, 0.7],
          [0.82, 1.0],
        ],
        width: 0.035,
      },
    ],
    scannerFeeds: 42,
    routeDemoPairs: [
      { from: "Williamsburg", to: "Midtown", fastestMin: 28, saferMin: 31, hotCount: 4 },
      { from: "Harlem", to: "Times Square", fastestMin: 24, saferMin: 27, hotCount: 3 },
      { from: "SoHo", to: "Astoria", fastestMin: 32, saferMin: 35, hotCount: 2 },
    ],
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
    brand: "PhillyPulse",
    tagline: "Real-time safety intelligence for the City of Brotherly Love.",
    // Liberty-Bell bronze-red
    accentRgb: "232, 93, 60",
    accentRgb2: "245, 166, 100",
    population: "1.58M",
    areaSqMi: 142,
    neighborhoods: [
      "Center City",
      "South Philly",
      "West Philly",
      "Kensington",
      "Fishtown",
      "North Philly",
      "University City",
      "Olney",
    ],
    gridStyle: "philly-penn",
    water: [
      // Schuylkill (west)
      {
        kind: "river",
        path: [
          [0.3, 0.0],
          [0.34, 0.25],
          [0.3, 0.5],
          [0.36, 0.78],
          [0.42, 1.0],
        ],
        width: 0.025,
      },
      // Delaware (east)
      {
        kind: "river",
        path: [
          [0.78, 0.0],
          [0.76, 0.3],
          [0.8, 0.6],
          [0.78, 1.0],
        ],
        width: 0.035,
      },
    ],
    scannerFeeds: 18,
    routeDemoPairs: [
      { from: "Fishtown", to: "Center City", fastestMin: 16, saferMin: 19, hotCount: 3 },
      { from: "University City", to: "Old City", fastestMin: 14, saferMin: 17, hotCount: 2 },
      { from: "South Philly", to: "Kensington", fastestMin: 20, saferMin: 23, hotCount: 4 },
    ],
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
    brand: "ChattaPulse",
    tagline: "Real-time safety intelligence for the Scenic City.",
    // Mountain / river green
    accentRgb: "95, 200, 120",
    accentRgb2: "140, 220, 160",
    population: "180K",
    areaSqMi: 143,
    neighborhoods: [
      "Downtown",
      "North Shore",
      "Southside",
      "Highland Park",
      "St. Elmo",
      "Red Bank",
      "Brainerd",
      "East Ridge",
    ],
    gridStyle: "chattanooga-bend",
    water: [
      // Tennessee River — distinctive bend (Moccasin Bend)
      {
        kind: "river",
        path: [
          [0.0, 0.38],
          [0.18, 0.35],
          [0.32, 0.28],
          [0.38, 0.18],
          [0.42, 0.1],
          [0.5, 0.2],
          [0.54, 0.38],
          [0.62, 0.46],
          [0.78, 0.48],
          [1.0, 0.44],
        ],
        width: 0.05,
      },
    ],
    scannerFeeds: 6,
    routeDemoPairs: [
      { from: "Southside", to: "Downtown", fastestMin: 11, saferMin: 14, hotCount: 2 },
      { from: "North Shore", to: "St. Elmo", fastestMin: 18, saferMin: 21, hotCount: 3 },
      { from: "Brainerd", to: "Highland Park", fastestMin: 15, saferMin: 18, hotCount: 2 },
    ],
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
