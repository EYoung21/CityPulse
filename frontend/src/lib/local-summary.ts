import type { Incident } from "@/lib/api";
import { getCurrentCity } from "@/lib/pulse-cities";

/** Lightweight summary when the Python summary API is unavailable. */
export function buildLocalSummary(incidents: Incident[]): string {
  if (incidents.length === 0) {
    return "No recent incidents to summarize.";
  }
  const recent = incidents.slice(0, 10);
  const lines = recent.map((inc) => {
    const cat = inc.severity_category.replace(/_/g, " ");
    const loc = inc.location_text ?? "Unknown location";
    return `${cat} at ${loc}`;
  });
  const cityName = getCurrentCity().name;
  return `${incidents.length} recent incidents across ${cityName}:\n${lines.join("\n")}`;
}
