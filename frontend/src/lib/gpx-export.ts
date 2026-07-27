/** GPX 1.1 serialization for trip history entries.
 *
 *  GPX (https://www.topografix.com/gpx.asp) is the de-facto exchange
 *  format for activity-tracking apps — Strava, Garmin Connect, Komoot,
 *  Wahoo, and everything else worth talking to all import it. We write
 *  the trip as a single `<trk>` containing one `<trkseg>` of timed
 *  track points. The timestamps are linearly interpolated between the
 *  start and end of the trip; they aren't real per-fix GPS times (we
 *  only stored the polyline, not a per-vertex log), but every importer
 *  we tested treats them as advisory and will happily accept them.
 *
 *  Anything that needs to be serialized into XML attributes/text gets
 *  routed through `xmlEscape` because trip notes can contain quotes
 *  and angle brackets that would otherwise corrupt the document.
 */

import type { TripHistoryEntry } from "@/lib/trip-history";

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case '"': return "&quot;";
      default:  return c;
    }
  });
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/** Serialize a single trip history entry as a GPX 1.1 document. Returns
 *  null when the entry has no geometry — callers should guard their UI
 *  on `hasExportableGeometry` to avoid showing an "Export" button for
 *  entries we can't actually export. */
export function tripToGpx(entry: TripHistoryEntry): string | null {
  if (!entry.geometry || entry.geometry.length < 2) return null;

  const points = entry.geometry;
  const span = Math.max(1, entry.endedAt - entry.startedAt);
  const trkptLines: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const [lat, lng] = points[i];
    // Even spacing in time; importers that recompute pace from
    // moving-time will get an "average pace" rather than a real one.
    const t = entry.startedAt + (i / (points.length - 1)) * span;
    trkptLines.push(
      `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"><time>${isoTime(t)}</time></trkpt>`
    );
  }

  const originLabel = entry.origin?.display_name ?? "Start";
  const destLabel = entry.dest?.display_name ?? "Destination";
  const trackName = `${originLabel} → ${destLabel}`;
  const description =
    `${entry.traveledKm.toFixed(2)} km / ${entry.mode}` +
    (entry.notes ? ` · ${entry.notes}` : "");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx
  version="1.1"
  creator="CityPulse"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${xmlEscape(trackName)}</name>
    <desc>${xmlEscape(description)}</desc>
    <time>${isoTime(entry.startedAt)}</time>
  </metadata>
  <trk>
    <name>${xmlEscape(trackName)}</name>
    <type>${xmlEscape(entry.mode)}</type>
    <trkseg>
${trkptLines.join("\n")}
    </trkseg>
  </trk>
</gpx>
`;
}

/** Build a sane "phillypulse-trip-2026-04-17.gpx" filename for the
 *  download attribute. Avoids trailing/leading dashes when origin or
 *  dest are missing. */
export function gpxFilenameFor(entry: TripHistoryEntry): string {
  const date = new Date(entry.startedAt).toISOString().slice(0, 10);
  const slug = (s: string | undefined) =>
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24);
  const o = slug(entry.origin?.display_name);
  const d = slug(entry.dest?.display_name);
  const tail = [o, d].filter(Boolean).join("--");
  return `phillypulse-trip-${date}${tail ? `-${tail}` : ""}.gpx`;
}

/** Trigger a browser download for the trip's GPX. No-op when the entry
 *  doesn't have geometry — caller should check first to avoid showing
 *  an inert button. */
export function downloadTripGpx(entry: TripHistoryEntry): boolean {
  const gpx = tripToGpx(entry);
  if (!gpx) return false;
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = gpxFilenameFor(entry);
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Defer revocation so Safari finishes the navigate-to-blob before we
  // pull the rug out — same workaround the Web Share API path uses.
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
  return true;
}

export function hasExportableGeometry(entry: TripHistoryEntry): boolean {
  return Array.isArray(entry.geometry) && entry.geometry.length >= 2;
}
