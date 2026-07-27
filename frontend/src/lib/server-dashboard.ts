import type { Query } from "firebase-admin/firestore";
import { ensureAdmin, type IncidentRow } from "@/lib/server-incidents";

export const CITY_DASHBOARD_META: Record<
  string,
  { name: string; publicSources: number }
> = {
  philly: { name: "Philadelphia", publicSources: 3 },
  nyc: { name: "New York City", publicSources: 1 },
  sf: { name: "San Francisco", publicSources: 2 },
  chattanooga: { name: "Chattanooga", publicSources: 1 },
};

const CATEGORY_LABELS: Record<string, string> = {
  violent_weapon: "weapons-related calls",
  violent_no_weapon: "assaults or fights",
  shots_heard: "shots-heard reports",
  robbery: "robberies",
  burglary_in_progress: "burglaries",
  medical_priority: "priority medical responses",
  medical_other: "medical responses",
  fire_hazmat: "fire or hazardous-material responses",
  traffic_crash_injury: "injury crashes",
  traffic_crash_no_injury: "traffic crashes",
  disorder: "disorder calls",
  admin_or_noise: "administrative calls",
};

function aggregateCount(
  result: Awaited<ReturnType<ReturnType<Query["count"]>["get"]>>,
): number {
  return result.data().count;
}

export function supportedDashboardCity(
  value: string | null | undefined,
): { slug: string; name: string; publicSources: number } | null {
  const slug = (value || "").trim().toLowerCase();
  const meta = CITY_DASHBOARD_META[slug];
  return meta ? { slug, ...meta } : null;
}

export function buildPublicActivitySummary(
  incidents: IncidentRow[],
  cityName: string,
): string {
  if (incidents.length === 0) {
    return `No recent public incident reports are available for ${cityName}.`;
  }

  const categoryCounts = new Map<string, number>();
  const locations: string[] = [];
  const seenLocations = new Set<string>();
  for (const incident of incidents) {
    const category =
      typeof incident.severity_category === "string"
        ? incident.severity_category
        : "other";
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    const location =
      typeof incident.location_text === "string"
        ? incident.location_text.trim()
        : "";
    if (location && !seenLocations.has(location.toLowerCase())) {
      seenLocations.add(location.toLowerCase());
      locations.push(location);
    }
  }

  const topCategories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(
      ([category, count]) =>
        `${count} ${CATEGORY_LABELS[category] || category.replaceAll("_", " ")}`,
    );
  const categorySentence = topCategories.length
    ? `The most common recent categories are ${topCategories.join(", ")}.`
    : "";
  const locationSentence = locations.length
    ? `Recent locations include ${locations.slice(0, 3).join(", ")}.`
    : "Some source records do not include a publishable location.";

  return [
    `${incidents.length} recent public incident reports are available for ${cityName}.`,
    categorySentence,
    locationSentence,
    "Reports are unverified and public locations are intentionally approximate.",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function cityIncidentCounts(city: string): Promise<{
  total: number;
  last24h: number;
  passed: number;
  blocked: number;
  newestIncidentAt: string | null;
}> {
  const { db } = ensureAdmin();
  const base = db.collection("incidents").where("city", "==", city);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000)
    .toISOString()
    .replace(/Z$/, "+00:00");

  const [totalResult, dayResult, passedResult, blockedResult, newestResult] =
    await Promise.all([
      base.count().get(),
      base.where("reported_at", ">=", since).count().get(),
      base.where("inhibitor_status", "==", "passed").count().get(),
      base.where("inhibitor_status", "==", "blocked").count().get(),
      base.orderBy("reported_at", "desc").limit(1).get(),
    ]);

  const newestValue = newestResult.docs[0]?.data().reported_at;
  return {
    total: aggregateCount(totalResult),
    last24h: aggregateCount(dayResult),
    passed: aggregateCount(passedResult),
    blocked: aggregateCount(blockedResult),
    newestIncidentAt:
      typeof newestValue === "string" ? newestValue.slice(0, 100) : null,
  };
}
