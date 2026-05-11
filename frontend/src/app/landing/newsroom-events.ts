/**
 * Demo events that drive the Newsroom section's cycling state machine.
 * Anchored to a heroIncidents index per event so each match has a real
 * lng/lat on the map to pulse. If the city has fewer heroIncidents than
 * needed, the section will modulo into the array.
 */

export interface NewsroomEvent {
  /** Keyword that "fired" — also doubles as the watch label. */
  keyword: string;
  /** Verbatim-ish scanner transcript snippet shown in the alert row. */
  transcript: string;
  /** Index into `city.heroIncidents` for the pulse location. */
  heroIndex: number;
}

export const NEWSROOM_EVENTS: NewsroomEvent[] = [
  {
    keyword: "shots fired",
    transcript:
      "Multiple shots fired, witnesses report male fleeing east on foot.",
    heroIndex: 0,
  },
  {
    keyword: "structure fire",
    transcript:
      "Working structure fire, second alarm requested. All units divert.",
    heroIndex: 1,
  },
  {
    keyword: "officer down",
    transcript:
      "Officer needs assistance, code 3. Hold the air for emergency traffic.",
    heroIndex: 2,
  },
  {
    keyword: "armed robbery",
    transcript:
      "Armed robbery in progress, suspect last seen wearing a black hoodie.",
    heroIndex: 0,
  },
];
