import { NextResponse } from "next/server";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

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

// Primary source is BART_API_KEY from the environment. The fallback below is
// BART's public demo key (documented at https://api.bart.gov/docs/overview/ and
// shared across all anonymous callers) — it is NOT a secret. Because it is shared
// it can be rate-limited/throttled, so set BART_API_KEY in production to use a
// dedicated key and avoid shared throttling.
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown, maxLength = 200): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalize(raw: unknown) {
  const data = asRecord(raw);
  const root = asRecord(data?.root);
  if (!root) {
    return { station_name: "", fetched_label: "", arrivals: [] };
  }
  const stations = asArray(root.station).map(asRecord).filter((row): row is Record<string, unknown> => row !== null);
  const station = stations[0] ?? null;
  if (!station) {
    return {
      station_name: "",
      fetched_label: cleanText(root.time, 100),
      arrivals: [],
    };
  }
  const out: {
    destination: string;
    minutes: string;
    color: string;
    platform?: string;
  }[] = [];
  for (const dest of asArray(station.etd).map(asRecord).filter((row): row is Record<string, unknown> => row !== null)) {
    const destination = cleanText(dest.destination);
    if (!destination) continue;
    for (const est of asArray(dest.estimate).map(asRecord).filter((row): row is Record<string, unknown> => row !== null)) {
      const rawHex = cleanText(est.hexcolor, 16) || `#${cleanText(est.color, 12)}`;
      const hex = /^#[0-9a-f]{6}$/i.test(rawHex) ? rawHex : "#888888";
      const minutes = cleanText(est.minutes, 20);
      if (!minutes) continue;
      out.push({
        destination,
        minutes,
        color: hex,
        platform: cleanText(est.platform, 20) || undefined,
      });
      if (out.length >= 100) break;
    }
    if (out.length >= 100) break;
  }
  // Numerically sortable: "Leaving" → 0, else parseInt.
  const byMin = (m: string) =>
    m === "Leaving" || m === "Now" ? 0 : Number.parseInt(m, 10) || 999;
  out.sort((a, b) => byMin(a.minutes) - byMin(b.minutes));
  return {
    station_name: cleanText(station.name),
    fetched_label: cleanText(root.time, 100),
    arrivals: out,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const op = url.searchParams.get("op") || "etd";

  try {
    if (op === "etd") {
      const station = (url.searchParams.get("station") || "").trim().toUpperCase();
      if (!/^[A-Z]{2,4}$/.test(station)) {
        return NextResponse.json(
          { error: "station param required (4-letter BART code)" },
          { status: 400 }
        );
      }
      const r = await fetch(
        `https://api.bart.gov/api/etd.aspx?cmd=etd&orig=${encodeURIComponent(station)}&key=${BART_KEY}&json=y`,
        { next: { revalidate: CACHE_TTL }, signal: AbortSignal.timeout(8_000) }
      );
      const raw = await readBoundedJsonResponse(r, 1024 * 1024).catch(() => null);
      const out = normalize(raw);
      const root = raw && typeof raw === "object"
        ? (raw as Partial<BartEtdRoot>).root
        : null;
      const payloadOk = Boolean(
        root && typeof root === "object" && !root.message?.error
      );
      return NextResponse.json({
        ...out,
        meta: { upstream_ok: r.ok && payloadOk, op, cached_ttl_s: CACHE_TTL },
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
