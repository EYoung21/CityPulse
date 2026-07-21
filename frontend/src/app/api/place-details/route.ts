import { NextResponse } from "next/server";
import { isCoordinatePair } from "@/lib/geo-validation";
import { normalizeHttpUrl } from "@/lib/safe-url";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

export const dynamic = "force-dynamic";

const TOMTOM_KEY = process.env.TOMTOM_API_KEY || "";
const TOMTOM_PLACE_BY_ID = "https://api.tomtom.com/search/2/place.json";

type PlaceDetails = {
  entityId?: string;
  provider: "tomtom";
  name?: string;
  address?: string;
  category?: string;
  categories?: string[];
  lat?: number;
  lng?: number;
  phone?: string;
  website?: string;
  openingHours?: unknown;
};

type TomTomPlace = {
  id?: string;
  position?: { lat?: number; lon?: number };
  poi?: {
    name?: string;
    phone?: string;
    url?: string;
    categories?: string[];
    classifications?: Array<{ names?: Array<{ name?: string }> }>;
    openingHours?: unknown;
  };
  address?: { freeformAddress?: string };
};

function clean(value: unknown, maxLength = 500): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function category(place: TomTomPlace): string | undefined {
  return (
    place.poi?.classifications
      ?.flatMap((c) => c.names ?? [])
      .map((n) => clean(n.name))
      .find(Boolean) ??
    place.poi?.categories?.map(clean).find(Boolean)
  );
}

function normalize(value: unknown): PlaceDetails | null {
  const record = asRecord(value);
  if (!record) return null;
  const place = record as TomTomPlace;
  const position = isCoordinatePair([place.position?.lat, place.position?.lon])
    ? place.position
    : undefined;
  return {
    entityId: clean(place.id),
    provider: "tomtom",
    name: clean(place.poi?.name),
    address: clean(place.address?.freeformAddress),
    category: category(place),
    categories: place.poi?.categories?.map(clean).filter((x): x is string => !!x),
    lat: position?.lat,
    lng: position?.lon,
    phone: clean(place.poi?.phone),
    website: normalizeHttpUrl(place.poi?.url) ?? undefined,
    openingHours: place.poi?.openingHours,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const entityId = clean(url.searchParams.get("entityId"));
  if (!entityId) {
    return NextResponse.json({ place: null, meta: { source: "none" } });
  }
  if (entityId.length > 256) {
    return NextResponse.json(
      { place: null, error: "entityId too long", meta: { source: "none" } },
      { status: 400 }
    );
  }
  if (!TOMTOM_KEY) {
    return NextResponse.json({ place: null, meta: { source: "missing-key" } });
  }

  const params = new URLSearchParams({
    entityId,
    key: TOMTOM_KEY,
    language: "en-US",
    openingHours: "nextSevenDays",
    timeZone: "iana",
  });

  try {
    const res = await fetch(`${TOMTOM_PLACE_BY_ID}?${params}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { place: null, meta: { source: "tomtom", status: res.status } },
        { status: 502 }
      );
    }
    const data = asRecord(await readBoundedJsonResponse(res, 2 * 1024 * 1024));
    const results = data?.results;
    const place = Array.isArray(results) && results.length > 0 ? normalize(results[0]) : null;
    return NextResponse.json({ place, meta: { source: "tomtom" } });
  } catch {
    return NextResponse.json(
      { place: null, meta: { source: "tomtom" } },
      { status: 502 }
    );
  }
}
