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

/** A geographic point, [lng, lat]. */
export type LngLat = [number, number];

/** Categories of "violent" landing-page demo blip we render on the map. */
export type LandingBlipKind = "gun" | "knife";

/**
 * One pulsing scanner-incident shown in the hero map background. We
 * intentionally hand-pick (lng, lat) per city so they always sit on
 * land near the camera center and match the in-app marker symbology.
 */
export interface HeroIncident {
  lng: number;
  lat: number;
  /** Single-glyph kinds use a violent-crime icon; "cluster" renders the
   *  same number-bubble used by the in-app marker-cluster. */
  kind: LandingBlipKind | "cluster";
  /** Number rendered inside the bubble when kind === "cluster". */
  count?: number;
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
  /** Real-world geo anchors so the demo overlay stays glued to streets
   *  even while the MapLibre camera drifts/rotates underneath. */
  fromLngLat: LngLat;
  toLngLat: LngLat;
  hotLngLat: LngLat;
  /** 2–4 violent-crime blips clustered near the hot zone. */
  blips: { lng: number; lat: number; kind: LandingBlipKind }[];
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
  /** Demo blips painted on top of the hero map background, anchored
   *  to real lng/lat so they follow the map's slow drift. */
  heroIncidents: HeroIncident[];
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
      {
        from: "Mission",
        to: "SoMa",
        fastestMin: 14,
        saferMin: 17,
        hotCount: 3,
        fromLngLat: [-122.4180, 37.7600],
        toLngLat: [-122.4020, 37.7780],
        hotLngLat: [-122.4115, 37.7700],
        blips: [
          { lng: -122.4150, lat: 37.7680, kind: "gun" },
          { lng: -122.4090, lat: 37.7720, kind: "knife" },
          { lng: -122.4120, lat: 37.7660, kind: "gun" },
        ],
      },
      {
        from: "Castro",
        to: "Financial District",
        fastestMin: 18,
        saferMin: 21,
        hotCount: 2,
        fromLngLat: [-122.4350, 37.7620],
        toLngLat: [-122.4000, 37.7950],
        hotLngLat: [-122.4180, 37.7800],
        blips: [
          { lng: -122.4220, lat: 37.7770, kind: "knife" },
          { lng: -122.4140, lat: 37.7820, kind: "gun" },
        ],
      },
      {
        from: "Richmond",
        to: "North Beach",
        fastestMin: 22,
        saferMin: 25,
        hotCount: 4,
        fromLngLat: [-122.4700, 37.7760],
        toLngLat: [-122.4100, 37.8060],
        hotLngLat: [-122.4400, 37.7910],
        blips: [
          { lng: -122.4440, lat: 37.7900, kind: "gun" },
          { lng: -122.4360, lat: 37.7930, kind: "knife" },
          { lng: -122.4400, lat: 37.7870, kind: "gun" },
        ],
      },
    ],
    heroIncidents: [
      { lng: -122.4830, lat: 37.7820, kind: "gun" },          // Outer Richmond
      { lng: -122.4640, lat: 37.7480, kind: "knife" },        // Sunset
      { lng: -122.4380, lat: 37.7340, kind: "gun" },          // Glen Park
      { lng: -122.4180, lat: 37.7250, kind: "cluster", count: 6 }, // Bernal
      { lng: -122.4090, lat: 37.7560, kind: "knife" },        // Mission
      { lng: -122.4030, lat: 37.7780, kind: "gun" },          // SoMa
      { lng: -122.3990, lat: 37.7910, kind: "cluster", count: 3 }, // FiDi
      { lng: -122.4140, lat: 37.8030, kind: "gun" },          // North Beach / Wharf
      { lng: -122.4480, lat: 37.7920, kind: "knife" },        // Pac Heights / Western Add.
      { lng: -122.4310, lat: 37.7650, kind: "gun" },          // Castro / Mission edge
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
      {
        from: "Williamsburg",
        to: "Midtown",
        fastestMin: 28,
        saferMin: 31,
        hotCount: 4,
        fromLngLat: [-73.9570, 40.7170],
        toLngLat: [-73.9850, 40.7550],
        hotLngLat: [-73.9750, 40.7350],
        blips: [
          { lng: -73.9780, lat: 40.7320, kind: "gun" },
          { lng: -73.9720, lat: 40.7380, kind: "knife" },
          { lng: -73.9700, lat: 40.7340, kind: "gun" },
          { lng: -73.9790, lat: 40.7360, kind: "knife" },
        ],
      },
      {
        from: "Harlem",
        to: "Times Square",
        fastestMin: 24,
        saferMin: 27,
        hotCount: 3,
        fromLngLat: [-73.9460, 40.8110],
        toLngLat: [-73.9855, 40.7580],
        hotLngLat: [-73.9650, 40.7850],
        blips: [
          { lng: -73.9680, lat: 40.7830, kind: "gun" },
          { lng: -73.9620, lat: 40.7870, kind: "knife" },
          { lng: -73.9640, lat: 40.7820, kind: "gun" },
        ],
      },
      {
        from: "SoHo",
        to: "Astoria",
        fastestMin: 32,
        saferMin: 35,
        hotCount: 2,
        fromLngLat: [-74.0000, 40.7230],
        toLngLat: [-73.9230, 40.7640],
        hotLngLat: [-73.9650, 40.7430],
        blips: [
          { lng: -73.9680, lat: 40.7400, kind: "knife" },
          { lng: -73.9620, lat: 40.7460, kind: "gun" },
        ],
      },
    ],
    heroIncidents: [
      { lng: -74.0150, lat: 40.7050, kind: "gun" },           // Battery / FiDi
      { lng: -73.9970, lat: 40.7180, kind: "knife" },         // LES
      { lng: -74.0090, lat: 40.7390, kind: "cluster", count: 8 }, // West Village
      { lng: -73.9870, lat: 40.7620, kind: "gun" },           // Midtown East
      { lng: -73.9550, lat: 40.7790, kind: "knife" },         // UES
      { lng: -73.9670, lat: 40.8030, kind: "gun" },           // Harlem
      { lng: -73.9320, lat: 40.7320, kind: "cluster", count: 4 }, // Greenpoint / N. Brooklyn
      { lng: -73.9450, lat: 40.6810, kind: "knife" },         // Bed-Stuy
      { lng: -73.9890, lat: 40.6920, kind: "gun" },           // Downtown Bklyn
      { lng: -73.9210, lat: 40.7660, kind: "knife" },         // Astoria
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
      {
        from: "Fishtown",
        to: "Center City",
        fastestMin: 16,
        saferMin: 19,
        hotCount: 3,
        fromLngLat: [-75.1300, 39.9710],
        toLngLat: [-75.1650, 39.9540],
        hotLngLat: [-75.1480, 39.9620],
        blips: [
          { lng: -75.1510, lat: 39.9605, kind: "gun" },
          { lng: -75.1450, lat: 39.9640, kind: "knife" },
          { lng: -75.1470, lat: 39.9595, kind: "gun" },
        ],
      },
      {
        from: "University City",
        to: "Old City",
        fastestMin: 14,
        saferMin: 17,
        hotCount: 2,
        fromLngLat: [-75.1980, 39.9510],
        toLngLat: [-75.1440, 39.9530],
        hotLngLat: [-75.1700, 39.9520],
        blips: [
          { lng: -75.1730, lat: 39.9530, kind: "knife" },
          { lng: -75.1670, lat: 39.9510, kind: "gun" },
        ],
      },
      {
        from: "South Philly",
        to: "Kensington",
        fastestMin: 20,
        saferMin: 23,
        hotCount: 4,
        fromLngLat: [-75.1700, 39.9260],
        toLngLat: [-75.1300, 39.9870],
        hotLngLat: [-75.1500, 39.9570],
        blips: [
          { lng: -75.1530, lat: 39.9550, kind: "gun" },
          { lng: -75.1470, lat: 39.9600, kind: "knife" },
          { lng: -75.1500, lat: 39.9540, kind: "gun" },
          { lng: -75.1490, lat: 39.9590, kind: "knife" },
        ],
      },
    ],
    heroIncidents: [
      { lng: -75.2210, lat: 39.9620, kind: "gun" },           // West Philly
      { lng: -75.1980, lat: 39.9460, kind: "knife" },         // University City
      { lng: -75.1820, lat: 39.9210, kind: "cluster", count: 5 }, // Grays Ferry
      { lng: -75.1640, lat: 39.9180, kind: "gun" },           // South Philly
      { lng: -75.1450, lat: 39.9320, kind: "knife" },         // Pennsport
      { lng: -75.1380, lat: 39.9590, kind: "gun" },           // Northern Liberties
      { lng: -75.1240, lat: 39.9740, kind: "cluster", count: 3 }, // Fishtown
      { lng: -75.1330, lat: 40.0010, kind: "knife" },         // Kensington
      { lng: -75.1700, lat: 39.9920, kind: "gun" },           // North Philly
      { lng: -75.1530, lat: 39.9510, kind: "knife" },         // Center City East
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
    brand: "423Pulse",
    tagline: "Real-time safety intelligence for the Scenic City.",
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
      {
        from: "Southside",
        to: "Downtown",
        fastestMin: 11,
        saferMin: 14,
        hotCount: 2,
        fromLngLat: [-85.3050, 35.0300],
        toLngLat: [-85.3100, 35.0500],
        hotLngLat: [-85.3075, 35.0400],
        blips: [
          { lng: -85.3090, lat: 35.0395, kind: "gun" },
          { lng: -85.3060, lat: 35.0410, kind: "knife" },
        ],
      },
      {
        from: "North Shore",
        to: "St. Elmo",
        fastestMin: 18,
        saferMin: 21,
        hotCount: 3,
        fromLngLat: [-85.3000, 35.0630],
        toLngLat: [-85.3430, 35.0000],
        hotLngLat: [-85.3200, 35.0300],
        blips: [
          { lng: -85.3220, lat: 35.0290, kind: "gun" },
          { lng: -85.3180, lat: 35.0310, kind: "knife" },
          { lng: -85.3200, lat: 35.0270, kind: "gun" },
        ],
      },
      {
        from: "Brainerd",
        to: "Highland Park",
        fastestMin: 15,
        saferMin: 18,
        hotCount: 2,
        fromLngLat: [-85.2350, 35.0220],
        toLngLat: [-85.2860, 35.0450],
        hotLngLat: [-85.2600, 35.0340],
        blips: [
          { lng: -85.2620, lat: 35.0330, kind: "knife" },
          { lng: -85.2580, lat: 35.0350, kind: "gun" },
        ],
      },
    ],
    heroIncidents: [
      { lng: -85.3460, lat: 35.0080, kind: "gun" },           // St. Elmo
      { lng: -85.3210, lat: 35.0250, kind: "knife" },         // Southside
      { lng: -85.3080, lat: 35.0400, kind: "cluster", count: 4 }, // Downtown
      { lng: -85.2860, lat: 35.0540, kind: "gun" },           // Highland Park
      { lng: -85.2640, lat: 35.0320, kind: "knife" },         // Brainerd
      { lng: -85.2420, lat: 35.0450, kind: "gun" },           // East Ridge
      { lng: -85.2920, lat: 35.0710, kind: "cluster", count: 2 }, // North Shore
      { lng: -85.3300, lat: 35.0830, kind: "knife" },         // Red Bank
      { lng: -85.3160, lat: 34.9930, kind: "gun" },           // Lookout Valley
      { lng: -85.2750, lat: 35.0860, kind: "knife" },         // Hixson
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
