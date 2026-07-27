import { NextResponse } from "next/server";
import {
  cityIncidentCounts,
  supportedDashboardCity,
} from "@/lib/server-dashboard";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  const city = supportedDashboardCity(slug);
  if (!city) {
    return NextResponse.json({ error: "unknown city" }, { status: 404 });
  }

  try {
    const counts = await cityIncidentCounts(city.slug);
    return NextResponse.json(
      {
        slug: city.slug,
        city_name: city.name,
        public_sources: city.publicSources,
        // Compatibility with older mobile/web clients.
        scanner_feeds: city.publicSources,
        incidents_24h: counts.last24h,
        incidents_total: counts.total,
        newest_incident_at: counts.newestIncidentAt,
        generated_at: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    console.error("[/api/city-stats] Firestore query failed", {
      city: city.slug,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "City statistics temporarily unavailable" },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
}
