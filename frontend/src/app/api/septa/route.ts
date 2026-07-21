import { NextResponse } from "next/server";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

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

function cleanText(value: unknown, maxLength = 200): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeArrival(value: unknown): Arrival | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const destination = cleanText(row.destination);
  const departTime = cleanText(row.depart_time, 64);
  const scheduledTime = cleanText(row.sched_time, 64);
  if (!destination || (!departTime && !scheduledTime)) return null;
  return {
    direction: cleanText(row.direction, 16),
    origin: cleanText(row.origin),
    destination,
    sched_time: scheduledTime,
    depart_time: departTime,
    status: cleanText(row.status, 100),
    line: typeof row.line === "string" ? cleanText(row.line, 100) : null,
    train_id: cleanText(row.train_id, 100),
    track: cleanText(row.track, 50),
    service_type: cleanText(row.service_type, 100),
  };
}

function normalizeArrivalList(value: unknown): Arrival[] {
  return Array.isArray(value)
    ? value
        .slice(0, 100)
        .map(normalizeArrival)
        .filter((row): row is Arrival => row !== null)
    : [];
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
    if (Array.isArray(obj.Northbound)) northbound = normalizeArrivalList(obj.Northbound);
    if (Array.isArray(obj.Southbound)) southbound = normalizeArrivalList(obj.Southbound);
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
      const station = (url.searchParams.get("station") || "").trim();
      if (!station || station.length > 100) {
        return NextResponse.json(
          { error: "station param required" },
          { status: 400 }
        );
      }
      const r = await fetch(
        `${SEPTA_BASE}/Arrivals/index.php?station=${encodeURIComponent(station)}`,
        { next: { revalidate: CACHE_TTL }, signal: AbortSignal.timeout(8_000) }
      );
      const raw = await readBoundedJsonResponse(r, 2 * 1024 * 1024).catch(() => null);
      const out = normalizeArrivals(station, raw);
      const payloadOk = Boolean(
        raw && typeof raw === "object" && !Array.isArray(raw)
      );
      return NextResponse.json({
        ...out,
        meta: { upstream_ok: r.ok && payloadOk, op, cached_ttl_s: CACHE_TTL },
      });
    }

    if (op === "next-to-arrive") {
      const from = (url.searchParams.get("from") || "").trim();
      const to = (url.searchParams.get("to") || "").trim();
      const nRaw = (url.searchParams.get("n") || "5").trim();
      if (!from || !to || from.length > 100 || to.length > 100) {
        return NextResponse.json(
          { error: "from and to params required" },
          { status: 400 }
        );
      }
      if (!/^\d+$/.test(nRaw) || Number(nRaw) < 1 || Number(nRaw) > 10) {
        return NextResponse.json(
          { error: "n must be an integer from 1 to 10" },
          { status: 400 }
        );
      }
      const n = String(Number(nRaw));
      const r = await fetch(
        `${SEPTA_BASE}/NextToArrive/index.php?req1=${encodeURIComponent(from)}&req2=${encodeURIComponent(to)}&req3=${encodeURIComponent(n)}`,
        { next: { revalidate: CACHE_TTL }, signal: AbortSignal.timeout(8_000) }
      );
      const raw = await readBoundedJsonResponse(r, 2 * 1024 * 1024).catch(() => null);
      return NextResponse.json({
        from,
        to,
        trips: Array.isArray(raw)
          ? raw.filter((row) => row && typeof row === "object" && !Array.isArray(row)).slice(0, 10)
          : [],
        meta: { upstream_ok: r.ok && Array.isArray(raw), op, cached_ttl_s: CACHE_TTL },
      });
    }

    if (op === "trainview") {
      const r = await fetch(`${SEPTA_BASE}/TrainView/index.php`, {
        // TrainView is the most-requested endpoint and changes every
        // few seconds — short cache so we still see movement.
        next: { revalidate: 5 },
        signal: AbortSignal.timeout(8_000),
      });
      const raw = await readBoundedJsonResponse(r, 2 * 1024 * 1024).catch(() => null);
      return NextResponse.json({
        trains: Array.isArray(raw)
          ? raw.filter((row) => row && typeof row === "object" && !Array.isArray(row)).slice(0, 500)
          : [],
        meta: { upstream_ok: r.ok && Array.isArray(raw), op, cached_ttl_s: 5 },
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
