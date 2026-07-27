import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";

const STRUCTURED_PUBLIC_SOURCES: Record<string, string> = {
  hc911: "Hamilton County 911",
  "datasf-police": "DataSF Police",
  "datasf-fire": "DataSF Fire",
  "phl-police": "Philadelphia Police Open Data",
  "montco-cad": "Montgomery County CAD",
  "chesco-cad": "Chester County CAD",
  "notify-nyc": "Notify NYC",
};

/** Primary incident copy: what happened, not where. */
export function incidentHeadline(inc: Incident): string {
  const sev = getSeverity(inc.severity_category);
  if (inc.description?.trim()) return inc.description.trim();
  const raw = inc.raw_text?.trim();
  if (raw) return raw.length > 140 ? `${raw.slice(0, 137)}…` : raw;
  return sev.label;
}

export function incidentLocationLabel(inc: Incident): string {
  return inc.location_text?.trim() || "Unknown location";
}

export function structuredPublicSourceLabel(inc: Incident): string | null {
  const feedId = inc.feed_id?.trim().toLowerCase() || "";
  return STRUCTURED_PUBLIC_SOURCES[feedId] || null;
}

export function isStructuredPublicIncident(inc: Incident): boolean {
  return structuredPublicSourceLabel(inc) !== null;
}
