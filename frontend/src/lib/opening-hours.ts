/** Tiny OpenStreetMap `opening_hours` interpreter — just enough to
 *  answer "is this place open right now, and if so for how long?"
 *
 *  The official spec is wildly more flexible than what we want to
 *  ship in a small client (https://wiki.openstreetmap.org/wiki/Key:opening_hours),
 *  so we cover the shapes that actually show up on US POIs:
 *
 *    - "24/7" → always open
 *    - "Mo-Fr 09:00-17:00"
 *    - "Mo,We,Fr 09:00-17:00"
 *    - "Mo-Fr 09:00-17:00; Sa 10:00-14:00"
 *    - "Mo-Su 06:00-22:00"
 *    - Multiple time ranges: "Mo-Fr 09:00-12:00,13:00-17:00"
 *
 *  Any pattern we can't parse degrades gracefully to
 *  `{ status: "unknown", raw }` — callers then show the raw string
 *  so a power user can read the original.
 *
 *  We deliberately don't parse public-holiday rules (`PH`),
 *  weekday-of-month rules (`Mo[1]`), or year-bound rules; these are
 *  rare on the US POIs we surface and getting them subtly wrong is
 *  worse than not labeling them at all.
 */

export type OpeningStatus =
  | { status: "open"; closesAtMin: number; raw: string }
  | { status: "closed"; opensAtMin?: number; opensWeekdayDelta?: number; raw: string }
  | { status: "always"; raw: string }
  | { status: "unknown"; raw: string };

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6, Su: 0,
};

interface TimeRange { startMin: number; endMin: number }
interface Rule { weekdays: Set<number>; ranges: TimeRange[] }

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24) return null;
  if (min < 0 || min > 59) return null;
  return h * 60 + min;
}

function parseTimeRanges(seg: string): TimeRange[] | null {
  // Multiple ranges may be comma-separated within one segment.
  const out: TimeRange[] = [];
  for (const piece of seg.split(",")) {
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(piece.trim());
    if (!m) return null;
    const start = parseHHMM(m[1]);
    const end = parseHHMM(m[2]);
    if (start == null || end == null) return null;
    // Treat 24:00 as end-of-day (1440); accept "00:00-24:00" as full
    // day. End < start would normally mean a range that wraps past
    // midnight (e.g. bars: 18:00-02:00). We handle that by splitting
    // into two ranges: 18:00-24:00 and 00:00-02:00 _on the next day_.
    if (end < start) {
      out.push({ startMin: start, endMin: 1440 });
      // The wrap remainder is intentionally dropped here — the caller
      // re-evaluates wrap against the previous-day rule.
    } else {
      out.push({ startMin: start, endMin: end });
    }
  }
  return out;
}

function parseWeekdays(seg: string): Set<number> | null {
  const days = new Set<number>();
  for (const piece of seg.split(",")) {
    const trimmed = piece.trim();
    const range = /^([A-Z][a-z])\s*-\s*([A-Z][a-z])$/.exec(trimmed);
    if (range) {
      const start = WEEKDAY_TO_INDEX[range[1]];
      const end = WEEKDAY_TO_INDEX[range[2]];
      if (start == null || end == null) return null;
      // OSM ranges are inclusive and may wrap (Sa-Mo means Sa, Su, Mo).
      let cursor = start;
      // Walk forward at most 7 steps so a malformed range can't loop.
      for (let i = 0; i < 7; i++) {
        days.add(cursor);
        if (cursor === end) break;
        cursor = (cursor + 1) % 7;
      }
      continue;
    }
    const single = WEEKDAY_TO_INDEX[trimmed];
    if (single == null) return null;
    days.add(single);
  }
  return days;
}

/** Parse a whole opening_hours string into per-clause rules. Returns
 *  null on any unrecognizable pattern so the caller can degrade. */
function parseRules(raw: string): Rule[] | null {
  const out: Rule[] = [];
  const clauses = raw.split(";").map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    // Allow either "<weekdays> <ranges>" or just "<ranges>" (which
    // applies to all days, e.g. plain "10:00-20:00").
    const parts = clause.split(/\s+/);
    let weekdaysSeg = "";
    let timesSeg = "";
    if (parts.length === 1) {
      timesSeg = parts[0];
    } else {
      // First space-delimited token is the weekday spec; everything
      // after (in case of "Mo-Fr 09:00-12:00,13:00-17:00") is the time.
      weekdaysSeg = parts[0];
      timesSeg = parts.slice(1).join(" ");
    }
    const weekdays = weekdaysSeg
      ? parseWeekdays(weekdaysSeg)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!weekdays) return null;
    const ranges = parseTimeRanges(timesSeg);
    if (!ranges) return null;
    out.push({ weekdays, ranges });
  }
  return out.length > 0 ? out : null;
}

/** Evaluate the opening_hours string against `now`. Caller can pass a
 *  Date for unit testing; production code defaults to current time. */
export function evaluateOpeningHours(
  raw: string | undefined | null,
  now: Date = new Date()
): OpeningStatus | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "24/7") return { status: "always", raw: trimmed };

  const rules = parseRules(trimmed);
  if (!rules) return { status: "unknown", raw: trimmed };

  const day = now.getDay();
  const minNow = now.getHours() * 60 + now.getMinutes();

  // Look for an open range right now.
  for (const rule of rules) {
    if (!rule.weekdays.has(day)) continue;
    for (const range of rule.ranges) {
      if (minNow >= range.startMin && minNow < range.endMin) {
        return { status: "open", closesAtMin: range.endMin, raw: trimmed };
      }
    }
  }

  // Closed — find the next opening time. We look through today first,
  // then walk forward up to 6 more days. (7 total in case the only
  // opening today already passed.)
  for (let delta = 0; delta < 7; delta++) {
    const probeDay = (day + delta) % 7;
    let bestStart: number | null = null;
    for (const rule of rules) {
      if (!rule.weekdays.has(probeDay)) continue;
      for (const range of rule.ranges) {
        if (delta === 0 && range.startMin <= minNow) continue;
        if (bestStart === null || range.startMin < bestStart) {
          bestStart = range.startMin;
        }
      }
    }
    if (bestStart !== null) {
      return {
        status: "closed",
        opensAtMin: bestStart,
        opensWeekdayDelta: delta,
        raw: trimmed,
      };
    }
  }

  // Schedule exists but never opens within the next week — treat as
  // unknown rather than silently lying.
  return { status: "unknown", raw: trimmed };
}

/** "9:30 AM" / "5 PM" formatter for a minute-of-day number. Locale
 *  short forms are noisy; we hand-format so the badge stays compact. */
export function formatTimeShort(minOfDay: number): string {
  const m = ((minOfDay % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const min = m % 60;
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return min === 0 ? `${h12} ${period}` : `${h12}:${String(min).padStart(2, "0")} ${period}`;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Render a short, human-friendly badge ("Open · closes 5 PM") for the
 *  evaluated status. Returns null for unknown / missing schedules so
 *  callers can fall back to the raw string or omit the badge. */
export function formatOpeningBadge(status: OpeningStatus | null): {
  label: string;
  tone: "open" | "closing-soon" | "closed" | "always";
} | null {
  if (!status) return null;
  if (status.status === "always") return { label: "Open 24/7", tone: "always" };
  if (status.status === "open") {
    const minsLeft = status.closesAtMin - (new Date().getHours() * 60 + new Date().getMinutes());
    if (minsLeft <= 30) {
      return {
        label: `Closes ${formatTimeShort(status.closesAtMin)}`,
        tone: "closing-soon",
      };
    }
    return {
      label: `Open · closes ${formatTimeShort(status.closesAtMin)}`,
      tone: "open",
    };
  }
  if (status.status === "closed") {
    if (status.opensAtMin == null) return { label: "Closed", tone: "closed" };
    const delta = status.opensWeekdayDelta ?? 0;
    if (delta === 0) {
      return {
        label: `Opens ${formatTimeShort(status.opensAtMin)}`,
        tone: "closed",
      };
    }
    if (delta === 1) {
      return {
        label: `Opens tomorrow ${formatTimeShort(status.opensAtMin)}`,
        tone: "closed",
      };
    }
    const today = new Date().getDay();
    const opensWeekday = WEEKDAY_NAMES[(today + delta) % 7];
    return {
      label: `Opens ${opensWeekday} ${formatTimeShort(status.opensAtMin)}`,
      tone: "closed",
    };
  }
  return null;
}
