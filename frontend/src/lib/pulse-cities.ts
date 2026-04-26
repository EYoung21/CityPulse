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

  /**
   * Preview-only cities have backend ingest + Firestore data but no
   * registered domain or polished landing page yet. They appear in the
   * Pulse Network nav with a "preview" tag and route via
   * `?city=<slug>` on the current host instead of `https://<domain>`.
   * Landing-page-only fields (heroIncidents, routeDemoPairs, water,
   * gridStyle, accentRgb, population, etc.) are optional for these.
   */
  previewOnly?: boolean;

  /**
   * Subset of `previewOnly` cities that we *publicly announce* as
   * "coming soon" on the landing page. Only cities flagged
   * `comingSoon: true` appear in the Pulse Network "coming soon"
   * roster on the marketing page. Implies `previewOnly: true`.
   */
  comingSoon?: boolean;

  /* ── Landing-page metadata (optional for previewOnly cities) ───── */
  /** City-specific brand name (e.g. "PhillyPulse"). */
  brand?: string;
  /** Tagline shown under the hero title. */
  tagline?: string;
  /** Accent color in "r, g, b" format (used in rgba()). */
  accentRgb?: string;
  /** Secondary accent for two-tone gradients, "r, g, b". */
  accentRgb2?: string;
  /** Human population string ("1.58M", "8.3M"). */
  population?: string;
  /** Approximate land area in square miles. */
  areaSqMi?: number;
  /** Notable neighborhoods rendered as hero stats. */
  neighborhoods?: string[];
  /** Characteristic grid pattern (retained for future procedural visuals). */
  gridStyle?: GridStyle;
  /** Characteristic water features (rivers, bays). */
  water?: WaterFeature[];
  /** Number of police-radio / scanner feeds we listen to here. */
  scannerFeeds?: number;
  /** Example origin→destination pairs cycled through the landing-page
   *  SafeRouteSection to demo the safer-routing pitch. 2–3 per city. */
  routeDemoPairs?: RouteDemoPair[];
  /** Demo blips painted on top of the hero map background, anchored
   *  to real lng/lat so they follow the map's slow drift. */
  heroIncidents?: HeroIncident[];
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
        hotCount: 4,
        fromLngLat: [-122.4180, 37.7600],
        toLngLat: [-122.4020, 37.7780],
        hotLngLat: [-122.4115, 37.7700],
        // Strung along the red corridor at ~25/45/60/80% of from→to so
        // the fastest line visibly cuts through them.
        blips: [
          { lng: -122.4140, lat: 37.7645, kind: "gun" },
          { lng: -122.4115, lat: 37.7700, kind: "knife" },
          { lng: -122.4090, lat: 37.7715, kind: "gun" },
          { lng: -122.4055, lat: 37.7755, kind: "knife" },
        ],
      },
      {
        from: "Castro",
        to: "Financial District",
        fastestMin: 18,
        saferMin: 21,
        hotCount: 3,
        fromLngLat: [-122.4350, 37.7620],
        toLngLat: [-122.4000, 37.7950],
        hotLngLat: [-122.4180, 37.7800],
        blips: [
          { lng: -122.4260, lat: 37.7710, kind: "knife" },
          { lng: -122.4180, lat: 37.7790, kind: "gun" },
          { lng: -122.4090, lat: 37.7880, kind: "knife" },
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
          { lng: -122.4540, lat: 37.7840, kind: "gun" },
          { lng: -122.4400, lat: 37.7910, kind: "knife" },
          { lng: -122.4260, lat: 37.7980, kind: "gun" },
          { lng: -122.4180, lat: 37.8025, kind: "knife" },
        ],
      },
    ],
    heroIncidents: [
      { lng: -122.5050, lat: 37.7790, kind: "gun" },          // Ocean Beach (W edge)
      { lng: -122.4830, lat: 37.7820, kind: "knife" },        // Outer Richmond
      { lng: -122.4640, lat: 37.7480, kind: "gun" },          // Sunset
      { lng: -122.4480, lat: 37.7920, kind: "cluster", count: 5 }, // Pac Heights
      { lng: -122.4380, lat: 37.7340, kind: "gun" },          // Glen Park
      { lng: -122.4310, lat: 37.7650, kind: "knife" },        // Castro
      { lng: -122.4180, lat: 37.7250, kind: "cluster", count: 6 }, // Bernal
      { lng: -122.4140, lat: 37.8030, kind: "gun" },          // North Beach
      { lng: -122.4090, lat: 37.7560, kind: "knife" },        // Mission
      { lng: -122.4030, lat: 37.7780, kind: "gun" },          // SoMa
      { lng: -122.3990, lat: 37.7910, kind: "cluster", count: 3 }, // FiDi
      { lng: -122.3870, lat: 37.7350, kind: "knife" },        // Bayview (E edge)
      { lng: -122.4910, lat: 37.7340, kind: "gun" },          // Lake Merced (SW)
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
          { lng: -73.9640, lat: 40.7260, kind: "gun" },
          { lng: -73.9710, lat: 40.7320, kind: "knife" },
          { lng: -73.9750, lat: 40.7350, kind: "gun" },
          { lng: -73.9810, lat: 40.7470, kind: "knife" },
        ],
      },
      {
        from: "Harlem",
        to: "Times Square",
        fastestMin: 24,
        saferMin: 27,
        hotCount: 4,
        fromLngLat: [-73.9460, 40.8110],
        toLngLat: [-73.9855, 40.7580],
        hotLngLat: [-73.9650, 40.7850],
        blips: [
          { lng: -73.9560, lat: 40.7990, kind: "gun" },
          { lng: -73.9650, lat: 40.7850, kind: "knife" },
          { lng: -73.9740, lat: 40.7720, kind: "gun" },
          { lng: -73.9810, lat: 40.7640, kind: "knife" },
        ],
      },
      {
        from: "SoHo",
        to: "Astoria",
        fastestMin: 32,
        saferMin: 35,
        hotCount: 3,
        fromLngLat: [-74.0000, 40.7230],
        toLngLat: [-73.9230, 40.7640],
        hotLngLat: [-73.9650, 40.7430],
        blips: [
          { lng: -73.9810, lat: 40.7330, kind: "knife" },
          { lng: -73.9650, lat: 40.7430, kind: "gun" },
          { lng: -73.9420, lat: 40.7540, kind: "knife" },
        ],
      },
    ],
    heroIncidents: [
      { lng: -74.0420, lat: 40.6890, kind: "gun" },           // Red Hook (W edge)
      { lng: -74.0150, lat: 40.7050, kind: "knife" },         // Battery / FiDi
      { lng: -74.0090, lat: 40.7390, kind: "cluster", count: 8 }, // West Village
      { lng: -73.9970, lat: 40.7180, kind: "gun" },           // LES
      { lng: -73.9890, lat: 40.6920, kind: "knife" },         // Downtown Bklyn
      { lng: -73.9870, lat: 40.7620, kind: "gun" },           // Midtown East
      { lng: -73.9670, lat: 40.8030, kind: "cluster", count: 5 }, // Harlem
      { lng: -73.9550, lat: 40.7790, kind: "knife" },         // UES
      { lng: -73.9450, lat: 40.6810, kind: "gun" },           // Bed-Stuy
      { lng: -73.9320, lat: 40.7320, kind: "cluster", count: 4 }, // Greenpoint
      { lng: -73.9210, lat: 40.7660, kind: "knife" },         // Astoria
      { lng: -73.8920, lat: 40.7480, kind: "gun" },           // Jackson Heights (E edge)
      { lng: -73.9100, lat: 40.8290, kind: "knife" },         // South Bronx (N)
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
      "North Philly",
      "University City",
      "Olney",
      "West Philly",
      "Kensington",
      "Fishtown",
      "Upper Darby",
      "Media",
      "West Chester",
      "King of Prussia",
      "Doylestown",
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
        hotCount: 4,
        fromLngLat: [-75.1300, 39.9710],
        toLngLat: [-75.1650, 39.9540],
        hotLngLat: [-75.1480, 39.9620],
        blips: [
          { lng: -75.1390, lat: 39.9665, kind: "gun" },
          { lng: -75.1480, lat: 39.9620, kind: "knife" },
          { lng: -75.1560, lat: 39.9580, kind: "gun" },
          { lng: -75.1620, lat: 39.9555, kind: "knife" },
        ],
      },
      {
        from: "University City",
        to: "Old City",
        fastestMin: 14,
        saferMin: 17,
        hotCount: 3,
        fromLngLat: [-75.1980, 39.9510],
        toLngLat: [-75.1440, 39.9530],
        hotLngLat: [-75.1700, 39.9520],
        blips: [
          { lng: -75.1830, lat: 39.9518, kind: "knife" },
          { lng: -75.1700, lat: 39.9520, kind: "gun" },
          { lng: -75.1570, lat: 39.9525, kind: "knife" },
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
          { lng: -75.1605, lat: 39.9410, kind: "gun" },
          { lng: -75.1500, lat: 39.9570, kind: "knife" },
          { lng: -75.1400, lat: 39.9720, kind: "gun" },
          { lng: -75.1340, lat: 39.9810, kind: "knife" },
        ],
      },
    ],
    heroIncidents: [
      { lng: -75.2480, lat: 39.9510, kind: "gun" },           // Cobbs Creek (W edge)
      { lng: -75.2210, lat: 39.9620, kind: "knife" },         // West Philly
      { lng: -75.1980, lat: 39.9460, kind: "cluster", count: 6 }, // University City
      { lng: -75.1820, lat: 39.9210, kind: "gun" },           // Grays Ferry
      { lng: -75.1640, lat: 39.9180, kind: "knife" },         // South Philly
      { lng: -75.1530, lat: 39.9510, kind: "gun" },           // Center City East
      { lng: -75.1450, lat: 39.9320, kind: "knife" },         // Pennsport
      { lng: -75.1380, lat: 39.9590, kind: "cluster", count: 4 }, // Northern Liberties
      { lng: -75.1240, lat: 39.9740, kind: "gun" },           // Fishtown
      { lng: -75.1330, lat: 40.0010, kind: "knife" },         // Kensington
      { lng: -75.1700, lat: 39.9920, kind: "gun" },           // North Philly
      { lng: -75.0830, lat: 39.9970, kind: "cluster", count: 3 }, // Frankford (E edge)
      { lng: -75.0900, lat: 39.9610, kind: "knife" },         // Port Richmond
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
        hotCount: 3,
        fromLngLat: [-85.3050, 35.0300],
        toLngLat: [-85.3100, 35.0500],
        hotLngLat: [-85.3075, 35.0400],
        blips: [
          { lng: -85.3060, lat: 35.0345, kind: "gun" },
          { lng: -85.3075, lat: 35.0400, kind: "knife" },
          { lng: -85.3090, lat: 35.0455, kind: "gun" },
        ],
      },
      {
        from: "North Shore",
        to: "St. Elmo",
        fastestMin: 18,
        saferMin: 21,
        hotCount: 4,
        fromLngLat: [-85.3000, 35.0630],
        toLngLat: [-85.3430, 35.0000],
        hotLngLat: [-85.3200, 35.0300],
        blips: [
          { lng: -85.3110, lat: 35.0470, kind: "gun" },
          { lng: -85.3200, lat: 35.0300, kind: "knife" },
          { lng: -85.3290, lat: 35.0150, kind: "gun" },
          { lng: -85.3370, lat: 35.0050, kind: "knife" },
        ],
      },
      {
        from: "Brainerd",
        to: "Highland Park",
        fastestMin: 15,
        saferMin: 18,
        hotCount: 3,
        fromLngLat: [-85.2350, 35.0220],
        toLngLat: [-85.2860, 35.0450],
        hotLngLat: [-85.2600, 35.0340],
        blips: [
          { lng: -85.2470, lat: 35.0280, kind: "knife" },
          { lng: -85.2600, lat: 35.0340, kind: "gun" },
          { lng: -85.2730, lat: 35.0395, kind: "knife" },
        ],
      },
    ],
    heroIncidents: [
      { lng: -85.3680, lat: 35.0030, kind: "gun" },           // Lookout Mtn (W edge)
      { lng: -85.3460, lat: 35.0080, kind: "knife" },         // St. Elmo
      { lng: -85.3300, lat: 35.0830, kind: "cluster", count: 3 }, // Red Bank (N)
      { lng: -85.3210, lat: 35.0250, kind: "gun" },           // Southside
      { lng: -85.3160, lat: 34.9930, kind: "knife" },         // Lookout Valley
      { lng: -85.3080, lat: 35.0400, kind: "cluster", count: 4 }, // Downtown
      { lng: -85.2920, lat: 35.0710, kind: "gun" },           // North Shore
      { lng: -85.2860, lat: 35.0540, kind: "knife" },         // Highland Park
      { lng: -85.2750, lat: 35.0860, kind: "cluster", count: 2 }, // Hixson
      { lng: -85.2640, lat: 35.0320, kind: "knife" },         // Brainerd
      { lng: -85.2420, lat: 35.0450, kind: "gun" },           // East Ridge
      { lng: -85.2150, lat: 35.0240, kind: "knife" },         // E. Brainerd (E edge)
      { lng: -85.2980, lat: 34.9810, kind: "gun" },           // Tiftonia (S)
    ],
  },

  /* ────────────────────────────────────────────────────────────────
   * Preview-only cities (backend ingest + Firestore live, no polished
   * landing page yet, no registered domain). Visit any deployed Pulse
   * site with `?city=<slug>` to view their data.
   * ──────────────────────────────────────────────────────────────── */
  {
    slug: "memphis",
    name: "Memphis",
    domain: "memphispulse.com",
    emoji: "🎷",
    lat: 35.1495,
    lng: -90.0490,
    nominatimViewbox: "-90.20,35.30,-89.85,35.00",
    geocodeSuffix: ", Memphis, TN",
    previewOnly: true,
    comingSoon: true,
  },
  {
    slug: "detroit",
    name: "Detroit",
    domain: "detroitpulse.com",
    emoji: "🚗",
    lat: 42.3314,
    lng: -83.0458,
    nominatimViewbox: "-83.30,42.45,-82.90,42.25",
    geocodeSuffix: ", Detroit, MI",
    previewOnly: true,
    comingSoon: true,
  },
  {
    slug: "orlando",
    name: "Orlando",
    domain: "orlandopulse.com",
    emoji: "🎢",
    lat: 28.5383,
    lng: -81.3792,
    nominatimViewbox: "-81.55,28.70,-81.20,28.40",
    geocodeSuffix: ", Orlando, FL",
    previewOnly: true,
    comingSoon: true,
  },
  {
    slug: "miami",
    name: "Miami",
    domain: "miamipulse.com",
    emoji: "🌴",
    lat: 25.7617,
    lng: -80.1918,
    nominatimViewbox: "-80.40,25.95,-80.10,25.60",
    geocodeSuffix: ", Miami, FL",
    previewOnly: true,
    comingSoon: true,
  },
  {
    slug: "la",
    name: "Los Angeles",
    domain: "lapulse.com",
    emoji: "🌅",
    lat: 34.0522,
    lng: -118.2437,
    nominatimViewbox: "-118.70,34.35,-118.10,33.70",
    geocodeSuffix: ", Los Angeles, CA",
    previewOnly: true,
    comingSoon: true,
  },
  {
    slug: "lasvegas",
    name: "Las Vegas",
    domain: "lasvegaspulse.com",
    emoji: "🎰",
    lat: 36.1699,
    lng: -115.1398,
    nominatimViewbox: "-115.40,36.35,-114.85,35.95",
    geocodeSuffix: ", Las Vegas, NV",
    previewOnly: true,
    comingSoon: true,
  },
];

/**
 * Geographic bounds for a city, derived from its `nominatimViewbox`
 * field. Returned as a MapLibre-friendly [[minLng, minLat], [maxLng,
 * maxLat]] tuple so it can be passed straight into `map.fitBounds()`
 * or the CityMapCanvas `bounds` prop. NOTE: this is the geocoder
 * search hint, which covers the wider metro region. For framing the
 * hero map prefer `heroIncidentBounds(city)` so markers don't end up
 * crushed against the viewport edges.
 */
export function cityBounds(
  city: PulseCity,
): [[number, number], [number, number]] {
  // nominatimViewbox = "left,top,right,bottom" = minLng,maxLat,maxLng,minLat
  const [minLng, maxLat, maxLng, minLat] = city.nominatimViewbox
    .split(",")
    .map(Number);
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

/**
 * Tight bounds for the hero map: the bbox of all hero incidents (plus
 * the city's nominal center as an anchor) padded by ~22% on each side.
 * Using the marker bbox — instead of the geocoder viewbox — guarantees
 * every blip sits well inside the visible frame regardless of city
 * size, so SF doesn't show the South Bay and Chattanooga doesn't show
 * empty Tennessee farmland around the urban core.
 */
export function heroIncidentBounds(
  city: PulseCity,
): [[number, number], [number, number]] {
  const hero = city.heroIncidents ?? [];
  const lngs = [city.lng, ...hero.map((i) => i.lng)];
  const lats = [city.lat, ...hero.map((i) => i.lat)];
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  // 22% padding gives the markers visual breathing room at the edges
  // without showing too much surrounding emptiness.
  const padLng = Math.max((maxLng - minLng) * 0.22, 0.01);
  const padLat = Math.max((maxLat - minLat) * 0.22, 0.008);
  return [
    [minLng - padLng, minLat - padLat],
    [maxLng + padLng, maxLat + padLat],
  ];
}

/**
 * Resolve deploy target. Resolution order:
 *   1. `?city=<slug>` query param (lets you preview any Pulse city
 *      from any deployed domain — primarily for previewOnly cities
 *      that don't have their own domain yet).
 *   2. NEXT_PUBLIC_CITY_SLUG env var (build-time per deployment).
 *   3. Production hostname match against `domain`.
 *   4. Philadelphia as the local-dev default.
 */
export function getCurrentCity(): PulseCity {
  if (typeof window !== "undefined") {
    try {
      const onLanding = window.location.pathname.startsWith("/landing");
      const qs = new URLSearchParams(window.location.search);
      const querySlug = qs.get("city")?.trim();
      // Only honor ?city= on in-app routes; the marketing landing
      // page requires hand-curated metadata that previewOnly cities
      // intentionally don't have.
      if (querySlug && !onLanding) {
        const byQuery = PULSE_CITIES.find((c) => c.slug === querySlug);
        if (byQuery) return byQuery;
      }
    } catch {
      // ignore — fall through to other resolution paths
    }
  }
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

/**
 * Cities with a real production domain (i.e. not previewOnly).
 * Used by surfaces that should never link to a placeholder host
 * such as the marketing landing-page nav and city switcher.
 */
export function getLaunchedCities(): PulseCity[] {
  return PULSE_CITIES.filter((c) => !c.previewOnly);
}
