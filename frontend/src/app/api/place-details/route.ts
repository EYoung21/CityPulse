import { NextResponse } from "next/server";

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

type TomTomPlaceResponse = {
  results?: TomTomPlace[];
};

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function normalize(place: TomTomPlace): PlaceDetails {
  return {
    entityId: clean(place.id),
    provider: "tomtom",
    name: clean(place.poi?.name),
    address: clean(place.address?.freeformAddress),
    category: category(place),
    categories: place.poi?.categories?.map(clean).filter((x): x is string => !!x),
    lat: place.position?.lat,
    lng: place.position?.lon,
    phone: clean(place.poi?.phone),
    website: clean(place.poi?.url),
    openingHours: place.poi?.openingHours,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const entityId = clean(url.searchParams.get("entityId"));
  if (!entityId) {
    return NextResponse.json({ place: null, meta: { source: "none" } });
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
    });
    if (!res.ok) {
      return NextResponse.json(
        { place: null, meta: { source: "tomtom", status: res.status } },
        { status: 502 }
      );
    }
    const data = (await res.json()) as TomTomPlaceResponse;
    const place = data.results?.[0] ? normalize(data.results[0]) : null;
    return NextResponse.json({ place, meta: { source: "tomtom" } });
  } catch {
    return NextResponse.json(
      { place: null, meta: { source: "tomtom" } },
      { status: 502 }
    );
  }
}
