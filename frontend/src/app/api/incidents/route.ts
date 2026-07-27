import { NextRequest, NextResponse } from "next/server";
import {
  CITY_RE,
  INCIDENT_CATEGORIES,
  effectiveSince,
  incidentHeaders,
  readIncidentWindow,
  resolveEntitlement,
} from "@/lib/server-incidents";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const city = (request.nextUrl.searchParams.get("city") || "").trim().toLowerCase();
  const category = (request.nextUrl.searchParams.get("category") || "").trim();
  const requestedSince = request.nextUrl.searchParams.get("since");
  if (!CITY_RE.test(city)) {
    return NextResponse.json({ error: "invalid city" }, { status: 400 });
  }
  if (category && !INCIDENT_CATEGORIES.has(category)) {
    return NextResponse.json({ error: "unknown severity category" }, { status: 400 });
  }
  if (requestedSince && !Number.isFinite(Date.parse(requestedSince))) {
    return NextResponse.json({ error: "invalid since timestamp" }, { status: 400 });
  }

  try {
    const entitlement = await resolveEntitlement(request);
    const { since, clamped } = effectiveSince(requestedSince, entitlement.isPro);
    const incidents = await readIncidentWindow({
      city,
      since,
      category: category || undefined,
      limit: 1_200,
    });
    return NextResponse.json(
      {
        incidents,
        meta: {
          tier: entitlement.isPro ? "pro" : "free",
          freeWindowSec: 72 * 60 * 60,
          clamped,
          effectiveSince: since,
          city,
        },
      },
      { headers: incidentHeaders(entitlement, clamped) },
    );
  } catch (error) {
    console.error("[/api/incidents] failed", {
      city,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "Incident feed temporarily unavailable" },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
}
