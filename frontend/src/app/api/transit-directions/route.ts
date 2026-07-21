import { NextResponse } from "next/server";
import { isCoordinatePair } from "@/lib/geo-validation";
import { readJsonBody, RequestBodyError } from "@/lib/server-body";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

export const dynamic = "force-dynamic";

/**
 * Transit routing proxy for OpenTripPlanner (OTP).
 *
 * Accepts origin/destination and returns a transit itinerary from an
 * OTP server configured via TRANSIT_OTP_URL. When the OTP server is
 * not configured, returns a 501 with a descriptive message so the
 * frontend can gracefully fall back.
 *
 * OTP expects the GraphQL endpoint at `${OTP_URL}/otp/routers/default/plan`.
 *
 * To deploy OTP with SEPTA GTFS:
 *   1. Download SEPTA GTFS from https://www3.septa.org/developer/
 *   2. Build an OTP graph: `java -jar otp.jar --build ./gtfs`
 *   3. Run the server: `java -jar otp.jar --load ./gtfs`
 *   4. Set TRANSIT_OTP_URL=http://your-otp-host:8080
 */

const OTP_URL = process.env.TRANSIT_OTP_URL || "";

type Body = {
  origin?: [number, number]; // [lat, lng]
  destination?: [number, number]; // [lat, lng]
  mode?: "TRANSIT" | "BUS" | "RAIL" | "SUBWAY";
  departAt?: string; // ISO datetime
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function nonNegativeNumber(value: unknown, fallback?: number): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return fallback ?? null;
}

function normalizeOtpItinerary(value: unknown, index: number) {
  const itinerary = asRecord(value);
  if (!itinerary) return null;
  const duration = nonNegativeNumber(itinerary.duration);
  const rawLegs = itinerary.legs;
  if (duration === null || !Array.isArray(rawLegs) || rawLegs.length === 0 || rawLegs.length > 64) {
    return null;
  }

  const legs = rawLegs.map((value) => {
    const leg = asRecord(value);
    const from = asRecord(leg?.from);
    const to = asRecord(leg?.to);
    if (
      !leg ||
      !from ||
      !to ||
      !isCoordinatePair([from.lat, from.lon]) ||
      !isCoordinatePair([to.lat, to.lon])
    ) {
      return null;
    }
    const geometry = asRecord(leg.legGeometry);
    return {
      mode: boundedText(leg.mode, 32) || "TRANSIT",
      from: {
        name: boundedText(from.name, 200) || "Stop",
        lat: from.lat,
        lng: from.lon,
      },
      to: {
        name: boundedText(to.name, 200) || "Stop",
        lat: to.lat,
        lng: to.lon,
      },
      startTime: nonNegativeNumber(leg.startTime, 0),
      endTime: nonNegativeNumber(leg.endTime, 0),
      durationMin: Math.round((nonNegativeNumber(leg.duration, 0) ?? 0) / 60),
      distanceM: Math.round(nonNegativeNumber(leg.distance, 0) ?? 0),
      route:
        boundedText(leg.routeShortName, 80) ||
        boundedText(leg.routeLongName, 160) ||
        boundedText(leg.route, 160) ||
        null,
      agency: boundedText(leg.agencyName, 160) || null,
      encodedPolyline: boundedText(geometry?.points, 500_000) || null,
    };
  });
  if (legs.some((leg) => leg === null)) return null;

  return {
    id: `transit-${index}`,
    durationMin: Math.round(duration / 60),
    walkDistanceM: Math.round(nonNegativeNumber(itinerary.walkDistance, 0) ?? 0),
    transitTimeMin: Math.round(
      (nonNegativeNumber(itinerary.transitTime, duration) ?? duration) / 60,
    ),
    legs,
  };
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await readJsonBody<Body>(request, 64 * 1024);
  } catch (err) {
    const status = err instanceof RequestBodyError ? err.status : 400;
    const message = err instanceof Error ? err.message : "Invalid JSON";
    return NextResponse.json({ error: message }, { status });
  }

  const { origin, destination, mode = "TRANSIT", departAt } = body;
  if (!isCoordinatePair(origin) || !isCoordinatePair(destination)) {
    return NextResponse.json(
      { error: "Need origin and destination as [lat, lng]" },
      { status: 400 }
    );
  }

  if (!new Set(["TRANSIT", "BUS", "RAIL", "SUBWAY"]).has(mode)) {
    return NextResponse.json({ error: "Unsupported transit mode" }, { status: 400 });
  }

  if (departAt && !Number.isFinite(Date.parse(departAt))) {
    return NextResponse.json({ error: "Invalid departure time" }, { status: 400 });
  }

  if (!OTP_URL) {
    return NextResponse.json(
      {
        error: "Transit routing not configured",
        message:
          "OpenTripPlanner backend is not deployed yet. Set TRANSIT_OTP_URL to enable transit directions.",
        fallback: "foot-walking",
      },
      { status: 501 }
    );
  }

  const now = departAt ? new Date(departAt).toISOString() : new Date().toISOString();
  const dateStr = now.slice(0, 10); // YYYY-MM-DD
  const timeStr = now.slice(11, 16); // HH:MM

  // OTP REST planner endpoint
  const params = new URLSearchParams({
    fromPlace: `${origin[0]},${origin[1]}`,
    toPlace: `${destination[0]},${destination[1]}`,
    date: dateStr,
    time: timeStr,
    mode: `WALK,${mode}`,
    numItineraries: "3",
    maxWalkDistance: "1500",
    arriveBy: "false",
  });

  const planUrl = `${OTP_URL}/otp/routers/default/plan?${params.toString()}`;

  try {
    const resp = await fetch(planUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CityPulse/1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      return NextResponse.json(
        { error: `OTP returned ${resp.status}` },
        { status: 502 }
      );
    }

    const data = asRecord(await readBoundedJsonResponse(resp, 4 * 1024 * 1024));
    const upstreamError = asRecord(data?.error);
    if (upstreamError) {
      return NextResponse.json(
        {
          error:
            boundedText(upstreamError.message, 500) ||
            boundedText(upstreamError.msg, 500) ||
            "OTP error",
        },
        { status: 404 }
      );
    }

    const plan = asRecord(data?.plan);
    const itineraries = plan?.itineraries;
    if (!Array.isArray(itineraries)) {
      return NextResponse.json({ error: "OTP returned an invalid payload" }, { status: 502 });
    }
    if (itineraries.length === 0) {
      return NextResponse.json(
        { error: "No transit route found" },
        { status: 404 }
      );
    }

    // Transform OTP itineraries into our standard format
    const results = itineraries
      .slice(0, 3)
      .map(normalizeOtpItinerary)
      .filter((itinerary): itinerary is NonNullable<typeof itinerary> => itinerary !== null);
    if (results.length === 0) {
      return NextResponse.json({ error: "OTP returned invalid itineraries" }, { status: 502 });
    }

    return NextResponse.json({ itineraries: results });
  } catch (err) {
    const msg =
      err instanceof Error && err.name === "TimeoutError"
        ? "OTP request timed out"
        : "Upstream fetch failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
