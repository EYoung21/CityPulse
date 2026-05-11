/**
 * Demo feed rows for the Research section. Each row references a
 * heroIncidents index so a corresponding pin can drop on the map.
 */

export interface ResearchRow {
  /** Minutes-ago timestamp shown in the feed. */
  minsAgo: number;
  category: string;
  /** Generic location string (the demo doesn't reverse-geocode). */
  location: string;
  snippet: string;
  /** Index into city.heroIncidents for the map pin. */
  heroIndex: number;
}

export const RESEARCH_ROWS: ResearchRow[] = [
  {
    minsAgo: 2,
    category: "Violent",
    location: "1500 block · Market St",
    snippet: "Shots fired, witnesses report male fleeing on foot.",
    heroIndex: 0,
  },
  {
    minsAgo: 7,
    category: "Fire",
    location: "Frankford & Allegheny",
    snippet: "Working structure fire, second alarm requested.",
    heroIndex: 1,
  },
  {
    minsAgo: 12,
    category: "Vehicle",
    location: "I-95 NB · MM 23",
    snippet: "Two-vehicle crash, lanes blocked, EMS en route.",
    heroIndex: 2,
  },
  {
    minsAgo: 18,
    category: "Police",
    location: "Old City",
    snippet: "Officer requesting backup, subject uncooperative.",
    heroIndex: 0,
  },
  {
    minsAgo: 26,
    category: "Medical",
    location: "13th & Spruce",
    snippet: "Cardiac arrest, CPR in progress.",
    heroIndex: 1,
  },
  {
    minsAgo: 34,
    category: "Violent",
    location: "Kensington Ave",
    snippet: "Armed robbery in progress, suspect last seen southbound.",
    heroIndex: 2,
  },
];
