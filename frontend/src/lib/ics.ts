/** Tiny RFC 5545 (.ics) generator. We only need single-event VCALENDARs
 *  for "remind me about this trip later", so the surface is intentionally
 *  small — no recurrence, no attendees, no alarms beyond a single
 *  configurable lead-time reminder.
 *
 *  We construct the file client-side and trigger a download via a
 *  blob URL so users on iOS / macOS / Android / Outlook all get the
 *  native "Add to calendar" sheet without needing a network round-trip. */

export interface IcsEvent {
  uid: string;
  title: string;
  description?: string;
  location?: string;
  startUtc: Date;
  endUtc: Date;
  /** Lead time in minutes for a popup reminder. Omit to skip the alarm. */
  reminderMin?: number;
  /** Geo coordinates "lat;lng" — recognized by Apple Calendar etc. */
  geo?: { lat: number; lng: number };
  url?: string;
}

function pad(n: number, w = 2): string {
  return n.toString().padStart(w, "0");
}

function fmtIcsDate(d: Date): string {
  // YYYYMMDDTHHMMSSZ — UTC. Calendar apps localize on display.
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

/** Escape per RFC 5545 §3.3.11 — comma, semicolon, backslash, newline. */
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

const UTF8_ENCODER = new TextEncoder();

function takeUtf8Prefix(value: string, maxBytes: number): [string, string] {
  let byteCount = 0;
  let codeUnitCount = 0;
  for (const char of value) {
    const charBytes = UTF8_ENCODER.encode(char).length;
    if (byteCount + charBytes > maxBytes) break;
    byteCount += charBytes;
    codeUnitCount += char.length;
  }
  return [value.slice(0, codeUnitCount), value.slice(codeUnitCount)];
}

/** RFC 5545 mandates lines wrap at 75 UTF-8 octets. Continuation lines
 *  start with one space, leaving 74 octets for their content. */
function fold(line: string): string {
  if (UTF8_ENCODER.encode(line).length <= 75) return line;
  const out: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const [chunk, remaining] = takeUtf8Prefix(rest, first ? 75 : 74);
    out.push(first ? chunk : ` ${chunk}`);
    rest = remaining;
    first = false;
  }
  return out.join("\r\n");
}

export function buildIcs(event: IcsEvent): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CityPulse//Trip planner//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${esc(event.uid)}`,
    `DTSTAMP:${fmtIcsDate(new Date())}`,
    `DTSTART:${fmtIcsDate(event.startUtc)}`,
    `DTEND:${fmtIcsDate(event.endUtc)}`,
    `SUMMARY:${esc(event.title)}`,
  ];

  if (event.description) lines.push(`DESCRIPTION:${esc(event.description)}`);
  if (event.location)    lines.push(`LOCATION:${esc(event.location)}`);
  if (event.url)         lines.push(`URL:${esc(event.url)}`);
  if (event.geo)         lines.push(`GEO:${event.geo.lat.toFixed(6)};${event.geo.lng.toFixed(6)}`);

  if (event.reminderMin != null && event.reminderMin > 0) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(event.title)}`,
      `TRIGGER:-PT${Math.round(event.reminderMin)}M`,
      "END:VALARM"
    );
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n");
}

/** Trigger a download of the .ics file in the browser. Falls back to a
 *  data URL on older browsers that block blob downloads. */
export function downloadIcs(event: IcsEvent, filename = "citypulse-trip.ics"): void {
  if (typeof window === "undefined") return;
  const ics = buildIcs(event);
  try {
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    const dataUrl = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    window.location.href = dataUrl;
  }
}
