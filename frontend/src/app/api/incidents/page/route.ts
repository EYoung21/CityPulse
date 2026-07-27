import { NextRequest, NextResponse } from "next/server";
import {
  CITY_RE,
  INCIDENT_CATEGORIES,
  effectiveSince,
  haversineKm,
  incidentHeaders,
  parseCursor,
  readIncidentPage,
  readIncidentWindow,
  resolveEntitlement,
} from "@/lib/server-incidents";

export const runtime = "nodejs";

function finiteCoordinate(value: string | null, min: number, max: number): number | null {
  if (value === null || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const city = (params.get("city") || "").trim().toLowerCase();
  const category = (params.get("category") || "").trim();
  const requestedSince = params.get("since");
  const cursorRaw = params.get("cursor");
  const limitRaw = Number(params.get("limit") || 20);
  const nearLatRaw = params.get("near_lat");
  const nearLngRaw = params.get("near_lng");
  const nearLat = finiteCoordinate(nearLatRaw, -90, 90);
  const nearLng = finiteCoordinate(nearLngRaw, -180, 180);

  if (!CITY_RE.test(city)) {
    return NextResponse.json({ error: "invalid city" }, { status: 400 });
  }
  if (category && !INCIDENT_CATEGORIES.has(category)) {
    return NextResponse.json({ error: "unknown severity category" }, { status: 400 });
  }
  if (requestedSince && !Number.isFinite(Date.parse(requestedSince))) {
    return NextResponse.json({ error: "invalid since timestamp" }, { status: 400 });
  }
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 50) {
    return NextResponse.json({ error: "invalid limit" }, { status: 400 });
  }
  if (cursorRaw && !parseCursor(cursorRaw)) {
    return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
  }
  if ((nearLatRaw === null) !== (nearLngRaw === null) || (nearLatRaw !== null && (nearLat === null || nearLng === null))) {
    return NextResponse.json({ error: "invalid proximity coordinates" }, { status: 400 });
  }

  try {
    const entitlement = await resolveEntitlement(request);
    const { since, clamped } = effectiveSince(requestedSince, entitlement.isPro);
    const parsedCursor = parseCursor(cursorRaw);
    const cursorClamped =
      !entitlement.isPro &&
      parsedCursor !== null &&
      parsedCursor.timestamp < since;
    const headers = incidentHeaders(entitlement, clamped || cursorClamped);
    if (cursorClamped) {
      return NextResponse.json(
        {
          incidents: [],
          next_cursor: null,
          mode: "recent",
          meta: {
            tier: "free",
            clamped: true,
            effectiveSince: since,
            paywalled: "history",
            city,
          },
        },
        { headers },
      );
    }
    if (nearLat !== null && nearLng !== null) {
      const rows = await readIncidentWindow({
        city,
        since,
        category: category || undefined,
        limit: 500,
      });
      const incidents = rows
        .flatMap((incident) => {
          const lat = typeof incident.lat === "number" ? incident.lat : Number.NaN;
          const lng = typeof incident.lng === "number" ? incident.lng : Number.NaN;
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
          return [{
            ...incident,
            distance_km: Math.round(haversineKm(nearLat, nearLng, lat, lng) * 1_000) / 1_000,
          }];
        })
        .sort((a, b) => a.distance_km - b.distance_km)
        .slice(0, limitRaw);
      return NextResponse.json(
        {
          incidents,
          next_cursor: null,
          mode: "near",
          meta: {
            tier: entitlement.isPro ? "pro" : "free",
            clamped,
            effectiveSince: since,
            city,
          },
        },
        { headers },
      );
    }

    const page = await readIncidentPage({
      city,
      since,
      category: category || undefined,
      cursor: cursorRaw,
      limit: limitRaw,
    });
    return NextResponse.json(
      {
        incidents: page.incidents,
        next_cursor: page.nextCursor,
        mode: "recent",
        meta: {
          tier: entitlement.isPro ? "pro" : "free",
          clamped,
          effectiveSince: since,
          city,
        },
      },
      { headers },
    );
  } catch (error) {
    console.error("[/api/incidents/page] failed", {
      city,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "Incident feed temporarily unavailable" },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
}
