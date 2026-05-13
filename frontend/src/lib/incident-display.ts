import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";

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
