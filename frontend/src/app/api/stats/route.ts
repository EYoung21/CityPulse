import { NextRequest, NextResponse } from "next/server";
import {
  cityIncidentCounts,
  supportedDashboardCity,
} from "@/lib/server-dashboard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const city = supportedDashboardCity(
    new URL(request.url).searchParams.get("city") || "philly",
  );
  if (!city) {
    return NextResponse.json({ error: "invalid city" }, { status: 400 });
  }

  try {
    const counts = await cityIncidentCounts(city.slug);
    return NextResponse.json(
      {
        total_incidents: counts.total,
        inhibitor_stats: {
          passed: counts.passed,
          blocked: counts.blocked,
        },
        city: city.slug,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    console.error("[/api/stats] Firestore query failed", {
      city: city.slug,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "Transparency statistics temporarily unavailable" },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
}
