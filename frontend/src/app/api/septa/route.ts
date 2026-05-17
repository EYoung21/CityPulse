import { NextResponse } from "next/server";

/** SEPTA proxy.
 *
 *  Wraps SEPTA's unauthenticated JSON endpoints (no key, no rate
 *  limits documented). We cache for ~20s server-side so a busy popup
 *  doesn't fan out one upstream request per render — SEPTA's
 *  Arrivals data only refreshes once a minute anyway.
 *
 *    /api/septa?op=arrivals&station=Swarthmore
 *    /api/septa?op=next-to-arrive&from=Swarthmore&to=Suburban%20Station&n=3
 *    /api/septa?op=trainview
 *
 *  Always returns 200 with a `meta.upstream_ok` flag so the client
 *  can show a graceful "SEPTA data unavailable" without inspecting
 *  HTTP status (some upstream errors come back as 200 with an empty
 *  body, which would otherwise look like "no arrivals"). */

// Revalidate window in seconds. Tied to SEPTA's own polling cadence —
// raising this trades freshness for fewer upstream hits.
const CACHE_TTL = 20;

const SEPTA_BASE = "https://www3.septa.org/api";

interface Arrival {
  direction: string;
  origin: string;
  destination: string;
  sched_time: string;
  depart_time: string;
  status: string;
  line: string | null;
  train_id: string;
  track: string;
  service_type: string;
  // Source has more fields — we forward only what the UI uses.
}

/** Shape of SEPTA's Arrivals endpoint:
 *    {
 *      "Station Departures: <human date>": [
 *        { "Northbound": [Arrival, ...] },
 *        { "Southbound": [Arrival, ...] }
 *      ]
 *    }
 *  We normalize to a flat object so the client doesn't have to parse
 *  the date-keyed wrapper. */
function normalizeArrivals(station: string, raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return {
      station,
      fetched_label: "",
      northbound: [] as Arrival[],
      southbound: [] as Arrival[],
    };
  }
  const top = raw as Record<string, unknown>;
  const firstKey = Object.keys(top).find((k) => k.startsWith(`${station} Departures`));
  if (!firstKey) {
    return { station, fetched_label: "", northbound: [], southbound: [] };
  }
  const groups = top[firstKey];
  if (!Array.isArray(groups)) {
    return { station, fetched_label: firstKey, northbound: [], southbound: [] };
  }
  let northbound: Arrival[] = [];
  let southbound: Arrival[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const obj = g as Record<string, unknown>;
    if (Array.isArray(obj.Northbound)) northbound = obj.Northbound as Arrival[];
    if (Array.isArray(obj.Southbound)) southbound = obj.Southbound as Arrival[];
  }
  return {
    station,
    fetched_label: firstKey.replace(`${station} Departures: `, "").trim(),
    northbound,
    southbound,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const op = url.searchParams.get("op") || "arrivals";

  try {
    if (op === "arrivals") {
      const station = url.searchParams.get("station") || "";
      if (!station) {
        return NextResponse.json(
          { error: "station param required" },
          { status: 400 }
        );
      }
      const r = await fetch(
        `${SEPTA_BASE}/Arrivals/index.php?station=${encodeURIComponent(station)}`,
        { next: { revalidate: CACHE_TTL } }
      );
      const raw = await r.json().catch(() => null);
      const out = normalizeArrivals(station, raw);
      return NextResponse.json({
        ...out,
        meta: { upstream_ok: r.ok, op, cached_ttl_s: CACHE_TTL },
      });
    }

    if (op === "next-to-arrive") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const n = url.searchParams.get("n") || "5";
      if (!from || !to) {
        return NextResponse.json(
          { error: "from and to params required" },
          { status: 400 }
        );
      }
      const r = await fetch(
        `${SEPTA_BASE}/NextToArrive/index.php?req1=${encodeURIComponent(from)}&req2=${encodeURIComponent(to)}&req3=${encodeURIComponent(n)}`,
        { next: { revalidate: CACHE_TTL } }
      );
      const raw = await r.json().catch(() => []);
      return NextResponse.json({
        from,
        to,
        trips: Array.isArray(raw) ? raw : [],
        meta: { upstream_ok: r.ok, op, cached_ttl_s: CACHE_TTL },
      });
    }

    if (op === "trainview") {
      const r = await fetch(`${SEPTA_BASE}/TrainView/index.php`, {
        // TrainView is the most-requested endpoint and changes every
        // few seconds — short cache so we still see movement.
        next: { revalidate: 5 },
      });
      const raw = await r.json().catch(() => []);
      return NextResponse.json({
        trains: Array.isArray(raw) ? raw : [],
        meta: { upstream_ok: r.ok, op, cached_ttl_s: 5 },
      });
    }

    return NextResponse.json(
      { error: `Unknown op: ${op}` },
      { status: 400 }
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "SEPTA proxy failed",
        meta: { upstream_ok: false, op },
      },
      { status: 502 }
    );
  }
}
