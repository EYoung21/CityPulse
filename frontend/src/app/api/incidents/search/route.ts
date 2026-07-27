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
  const params = request.nextUrl.searchParams;
  const q = (params.get("q") || "").trim().slice(0, 200);
  const city = (params.get("city") || "").trim().toLowerCase();
  const category = (params.get("category") || "").trim();
  const requestedSince = params.get("since");
  const untilRaw = params.get("until");
  const limitRaw = Number(params.get("limit") || 50);
  if (!q || !CITY_RE.test(city)) {
    return NextResponse.json({ error: "invalid search" }, { status: 400 });
  }
  if (category && !INCIDENT_CATEGORIES.has(category)) {
    return NextResponse.json({ error: "unknown severity category" }, { status: 400 });
  }
  if (
    (requestedSince && !Number.isFinite(Date.parse(requestedSince))) ||
    (untilRaw && !Number.isFinite(Date.parse(untilRaw)))
  ) {
    return NextResponse.json({ error: "invalid timestamp" }, { status: 400 });
  }
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) {
    return NextResponse.json({ error: "invalid limit" }, { status: 400 });
  }

  try {
    const entitlement = await resolveEntitlement(request);
    const { since, clamped } = effectiveSince(requestedSince, entitlement.isPro);
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const until = untilRaw ? Date.parse(untilRaw) : null;
    const rows = await readIncidentWindow({
      city,
      since,
      category: category || undefined,
      limit: 500,
    });
    const matched = rows.filter((incident) => {
      if (until !== null) {
        const reported =
          typeof incident.reported_at === "string"
            ? Date.parse(incident.reported_at)
            : Number.NaN;
        if (!Number.isFinite(reported) || reported > until) return false;
      }
      const searchable = [
        incident.raw_text,
        incident.severity_category,
        incident.description,
        incident.location_text,
      ]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
    return NextResponse.json(
      {
        results: matched.slice(0, limitRaw),
        total: matched.length,
        query: q,
        terms,
        meta: {
          tier: entitlement.isPro ? "pro" : "free",
          clamped,
          effectiveSince: since,
          city,
        },
      },
      { headers: incidentHeaders(entitlement, clamped) },
    );
  } catch (error) {
    console.error("[/api/incidents/search] failed", {
      city,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "Incident search temporarily unavailable" },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
}
