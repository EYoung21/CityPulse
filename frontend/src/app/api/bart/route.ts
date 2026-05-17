import { NextResponse } from "next/server";

/** BART proxy.
 *
 *    /api/bart?op=etd&station=POWL
 *
 *  Uses BART's long-standing public demo key. If you want a personal
 *  key (https://api.bart.gov/api/register.aspx), set BART_API_KEY in
 *  the env and we'll prefer it. Throttling on the demo key has been
 *  generous-to-nonexistent for over a decade, but a real key is
 *  polite once we're sending nontrivial traffic. */

const CACHE_TTL = 20;

const BART_KEY = process.env.BART_API_KEY || "MW9S-E7SL-26DU-VV8V";

interface BartEtdEstimate {
  minutes: string;
  platform?: string;
  direction?: string;
  length?: string;
  color?: string;
  hexcolor?: string;
  bikeflag?: string;
  delay?: string;
}

interface BartEtdDestination {
  destination: string;
  abbreviation?: string;
  estimate?: BartEtdEstimate | BartEtdEstimate[];
}

interface BartEtdStation {
  name: string;
  abbr: string;
  etd?: BartEtdDestination | BartEtdDestination[];
  message?: { error?: string };
}

interface BartEtdRoot {
  root: {
    date?: string;
    time?: string;
    station?: BartEtdStation | BartEtdStation[];
    message?: { warning?: string; error?: string };
  };
}

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

function normalize(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return { station_name: "", fetched_label: "", arrivals: [] };
  }
  const data = raw as BartEtdRoot;
  const stations = asArray(data.root?.station);
  const station = stations[0];
  if (!station) {
    return {
      station_name: "",
      fetched_label: data.root?.time ?? "",
      arrivals: [],
    };
  }
  const out: {
    destination: string;
    minutes: string;
    color: string;
    platform?: string;
  }[] = [];
  for (const dest of asArray(station.etd)) {
    for (const est of asArray(dest.estimate)) {
      const hex = est.hexcolor || (est.color ? `#${est.color}` : "#888888");
      out.push({
        destination: dest.destination,
        minutes: est.minutes,
        color: hex,
        platform: est.platform,
      });
    }
  }
  // Numerically sortable: "Leaving" → 0, else parseInt.
  const byMin = (m: string) =>
    m === "Leaving" || m === "Now" ? 0 : Number.parseInt(m, 10) || 999;
  out.sort((a, b) => byMin(a.minutes) - byMin(b.minutes));
  return {
    station_name: station.name,
    fetched_label: data.root?.time ?? "",
    arrivals: out,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const op = url.searchParams.get("op") || "etd";

  try {
    if (op === "etd") {
      const station = url.searchParams.get("station") || "";
      if (!station || station.length > 4) {
        return NextResponse.json(
          { error: "station param required (4-letter BART code)" },
          { status: 400 }
        );
      }
      const r = await fetch(
        `https://api.bart.gov/api/etd.aspx?cmd=etd&orig=${encodeURIComponent(station)}&key=${BART_KEY}&json=y`,
        { next: { revalidate: CACHE_TTL } }
      );
      const raw = await r.json().catch(() => null);
      const out = normalize(raw);
      return NextResponse.json({
        ...out,
        meta: { upstream_ok: r.ok, op, cached_ttl_s: CACHE_TTL },
      });
    }

    return NextResponse.json(
      { error: `unknown op: ${op}` },
      { status: 400 }
    );
  } catch (e) {
    return NextResponse.json(
      {
        station_name: "",
        fetched_label: "",
        arrivals: [],
        error: e instanceof Error ? e.message : "BART proxy failed",
        meta: { upstream_ok: false, op },
      },
      { status: 502 }
    );
  }
}
