import { NextResponse } from "next/server";

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

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { origin, destination, mode = "TRANSIT", departAt } = body;
  if (
    !Array.isArray(origin) ||
    origin.length !== 2 ||
    !Array.isArray(destination) ||
    destination.length !== 2
  ) {
    return NextResponse.json(
      { error: "Need origin and destination as [lat, lng]" },
      { status: 400 }
    );
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

  const now = departAt || new Date().toISOString();
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

    const data = (await resp.json()) as {
      plan?: {
        itineraries?: Array<{
          duration: number; // seconds
          walkDistance: number; // meters
          transitTime: number; // seconds
          legs: Array<{
            mode: string;
            from: { name: string; lat: number; lon: number };
            to: { name: string; lat: number; lon: number };
            startTime: number;
            endTime: number;
            duration: number;
            distance: number;
            route?: string;
            routeShortName?: string;
            routeLongName?: string;
            agencyName?: string;
            legGeometry?: { points: string; length: number };
          }>;
        }>;
      };
      error?: { id: number; msg: string; message: string };
    };

    if (data.error) {
      return NextResponse.json(
        { error: data.error.message || data.error.msg || "OTP error" },
        { status: 404 }
      );
    }

    const itineraries = data.plan?.itineraries ?? [];
    if (itineraries.length === 0) {
      return NextResponse.json(
        { error: "No transit route found" },
        { status: 404 }
      );
    }

    // Transform OTP itineraries into our standard format
    const results = itineraries.map((itin, idx) => ({
      id: `transit-${idx}`,
      durationMin: Math.round(itin.duration / 60),
      walkDistanceM: Math.round(itin.walkDistance),
      transitTimeMin: Math.round(itin.transitTime / 60),
      legs: itin.legs.map((leg) => ({
        mode: leg.mode,
        from: { name: leg.from.name, lat: leg.from.lat, lng: leg.from.lon },
        to: { name: leg.to.name, lat: leg.to.lat, lng: leg.to.lon },
        startTime: leg.startTime,
        endTime: leg.endTime,
        durationMin: Math.round(leg.duration / 60),
        distanceM: Math.round(leg.distance),
        route: leg.routeShortName || leg.routeLongName || leg.route || null,
        agency: leg.agencyName || null,
        encodedPolyline: leg.legGeometry?.points || null,
      })),
    }));

    return NextResponse.json({ itineraries: results });
  } catch (err) {
    const msg =
      err instanceof Error && err.name === "TimeoutError"
        ? "OTP request timed out"
        : "Upstream fetch failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
