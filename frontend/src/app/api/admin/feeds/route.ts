import { NextRequest, NextResponse } from "next/server";

const SOURCES: Record<string, { feed_id: string; label: string; supports_audio: false }[]> = {
  chattanooga: [
    { feed_id: "hc911", label: "Hamilton County 911 CAD", supports_audio: false },
  ],
  sf: [
    { feed_id: "datasf-police", label: "DataSF Police CAD", supports_audio: false },
    { feed_id: "datasf-fire", label: "San Francisco Fire Department Calls", supports_audio: false },
  ],
  philly: [
    { feed_id: "phl-police", label: "Philadelphia Police Incidents", supports_audio: false },
    { feed_id: "montco-cad", label: "Montgomery County Live CAD", supports_audio: false },
    { feed_id: "chesco-cad", label: "Chester County Live CAD", supports_audio: false },
  ],
  nyc: [
    { feed_id: "notify-nyc", label: "Notify NYC", supports_audio: false },
  ],
};

export function GET(request: NextRequest) {
  const city = (request.nextUrl.searchParams.get("city") || "").trim().toLowerCase();
  return NextResponse.json(
    { feeds: SOURCES[city] || [] },
    {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    },
  );
}
