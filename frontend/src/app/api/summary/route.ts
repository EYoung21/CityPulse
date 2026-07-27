import { NextRequest, NextResponse } from "next/server";
import {
  FREE_WINDOW_SECONDS,
  effectiveSince,
  readIncidentPage,
  resolveEntitlement,
} from "@/lib/server-incidents";
import {
  buildPublicActivitySummary,
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

  const entitlement = await resolveEntitlement(request);
  const access = effectiveSince(null, entitlement.isPro);
  try {
    const page = await readIncidentPage({
      city: city.slug,
      since: access.since,
      limit: 20,
    });
    const headers: Record<string, string> = {
      Vary: "Authorization",
      "Cache-Control": entitlement.authenticated
        ? "private, no-store"
        : "public, s-maxage=30, stale-while-revalidate=120",
    };
    if (!entitlement.isPro) {
      headers["X-Pulse-Free-Window-Sec"] = String(FREE_WINDOW_SECONDS);
    }
    return NextResponse.json(
      {
        summary: buildPublicActivitySummary(page.incidents, city.name),
        incident_count: page.incidents.length,
        meta: {
          tier: entitlement.isPro ? "pro" : "free",
          freeWindowSec: FREE_WINDOW_SECONDS,
          clamped: false,
          effectiveSince: access.since,
          city: city.slug,
        },
      },
      { headers },
    );
  } catch (error) {
    console.error("[/api/summary] Firestore query failed", {
      city: city.slug,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "Incident summary temporarily unavailable" },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
}
