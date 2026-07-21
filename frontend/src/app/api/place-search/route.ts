import { NextResponse } from "next/server";
import { PULSE_CITIES, cityBounds, type PulseCity } from "@/lib/pulse-cities";
import { isCoordinatePair } from "@/lib/geo-validation";
import { normalizeHttpUrl } from "@/lib/safe-url";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

export const dynamic = "force-dynamic";

const TOMTOM_KEY = process.env.TOMTOM_API_KEY || "";
const TOMTOM_SEARCH_BASE = "https://api.tomtom.com/search/2";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

type PlaceProvider = "tomtom" | "nominatim";

type PlaceSearchResult = {
  id?: string;
  entityId?: string;
  provider: PlaceProvider;
  source: PlaceProvider;
  type?: string;
  display_name: string;
  name: string;
  address?: string;
  category?: string;
  categories?: string[];
  lat: number;
  lng: number;
  phone?: string;
  website?: string;
  openingHours?: unknown;
  distanceM?: number;
  score?: number;
};

type TomTomResult = {
  id?: string;
  type?: string;
  score?: number;
  dist?: number;
  position?: { lat?: number; lon?: number };
  poi?: {
    name?: string;
    phone?: string;
    url?: string;
    categories?: string[];
    classifications?: Array<{
      code?: string;
      names?: Array<{ name?: string; nameLocale?: string }>;
    }>;
    openingHours?: unknown;
  };
  address?: {
    freeformAddress?: string;
    streetName?: string;
    municipality?: string;
    countrySubdivision?: string;
    postalCode?: string;
  };
  dataSources?: {
    geometry?: { id?: string };
  };
};

type NominatimResult = {
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
};

function cityFromRequest(url: URL): PulseCity | null {
  const slug = url.searchParams.get("city")?.trim();
  if (slug) {
    const bySlug = PULSE_CITIES.find((c) => c.slug === slug);
    return bySlug ?? null;
  }
  return PULSE_CITIES.find((c) => c.slug === "philly")!;
}

function cleanString(value: unknown, maxLength = 500): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstCategory(result: TomTomResult): string | undefined {
  const byClassification = result.poi?.classifications
    ?.flatMap((c) => c.names ?? [])
    .map((n) => cleanString(n.name))
    .find(Boolean);
  return byClassification ?? result.poi?.categories?.map(cleanString).find(Boolean);
}

function tomTomName(result: TomTomResult): string {
  return (
    cleanString(result.poi?.name) ??
    cleanString(result.address?.freeformAddress) ??
    cleanString(result.address?.streetName) ??
    cleanString(result.id) ??
    "Place"
  );
}

function normalizeTomTom(value: unknown): PlaceSearchResult | null {
  const record = asRecord(value);
  if (!record) return null;
  const result = record as TomTomResult;
  const lat = result.position?.lat;
  const lng = result.position?.lon;
  if (!isCoordinatePair([lat, lng])) return null;

  const name = tomTomName(result);
  const address = cleanString(result.address?.freeformAddress);
  const category = firstCategory(result);
  const categories = result.poi?.categories?.map(cleanString).filter((x): x is string => !!x);
  const entityId = cleanString(result.id) ?? cleanString(result.dataSources?.geometry?.id);
  const displayParts = [
    name,
    category && category.toLowerCase() !== name.toLowerCase() ? category : undefined,
    address,
  ].filter(Boolean);

  return {
    id: result.id,
    entityId,
    provider: "tomtom",
    source: "tomtom",
    type: result.type,
    display_name: displayParts.join(", "),
    name,
    address,
    category,
    categories,
    lat: lat!,
    lng: lng!,
    phone: cleanString(result.poi?.phone),
    website: normalizeHttpUrl(result.poi?.url) ?? undefined,
    openingHours: result.poi?.openingHours,
    distanceM: typeof result.dist === "number" ? Math.round(result.dist) : undefined,
    score: result.score,
  };
}

function tomTomParams(url: URL, city: PulseCity): URLSearchParams {
  const latRaw = url.searchParams.get("lat");
  const lngRaw = url.searchParams.get("lng");
  // Number(null) is 0, which is a valid coordinate. Parse absent values as
  // NaN so an un-biased search is centered on the selected city rather than
  // accidentally searching around 0,0 in the Gulf of Guinea.
  const lat = latRaw === null ? Number.NaN : Number(latRaw);
  const lng = lngRaw === null ? Number.NaN : Number(lngRaw);
  const params = new URLSearchParams({
    key: TOMTOM_KEY,
    limit: String(Math.min(15, Math.max(1, Number(url.searchParams.get("limit")) || 8))),
    language: "en-US",
    countrySet: "US",
    typeahead: "true",
    openingHours: "nextSevenDays",
    timeZone: "iana",
  });

  if (isCoordinatePair([lat, lng])) {
    params.set("lat", lat.toFixed(6));
    params.set("lon", lng.toFixed(6));
    params.set("radius", String(Math.min(50_000, Math.max(500, Number(url.searchParams.get("radius")) || 15_000))));
  } else {
    params.set("lat", city.lat.toFixed(6));
    params.set("lon", city.lng.toFixed(6));
    params.set("radius", "40000");
  }
  return params;
}

async function searchTomTom(url: URL, city: PulseCity): Promise<PlaceSearchResult[] | null> {
  if (!TOMTOM_KEY) return null;

  const rawCategory = cleanString(url.searchParams.get("category"));
  const rawQuery = cleanString(url.searchParams.get("q"));
  const term = rawCategory ?? rawQuery;
  if (!term) return [];

  const params = tomTomParams(url, city);
  const endpoint = rawCategory
    ? `${TOMTOM_SEARCH_BASE}/poiSearch/${encodeURIComponent(term)}.json`
    : `${TOMTOM_SEARCH_BASE}/search/${encodeURIComponent(term)}.json`;

  const res = await fetch(`${endpoint}?${params}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;

  const data = asRecord(await readBoundedJsonResponse(res, 2 * 1024 * 1024));
  const results = data?.results;
  if (!Array.isArray(results)) return null;
  return results
    .slice(0, 100)
    .map(normalizeTomTom)
    .filter((x): x is PlaceSearchResult => !!x);
}

async function searchNominatim(url: URL, city: PulseCity): Promise<PlaceSearchResult[]> {
  const rawCategory = cleanString(url.searchParams.get("category"));
  const rawQuery = cleanString(url.searchParams.get("q"));
  const term = rawQuery ?? rawCategory;
  if (!term) return [];

  const nameLower = city.name.toLowerCase();
  const q = term.toLowerCase().includes(nameLower) ? term : `${term}${city.geocodeSuffix}`;
  const params = new URLSearchParams({
    q,
    format: "json",
    addressdetails: "1",
    limit: String(Math.min(15, Math.max(1, Number(url.searchParams.get("limit")) || 8))),
    viewbox: city.nominatimViewbox,
    bounded: "1",
  });

  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    cache: "no-store",
    headers: { "User-Agent": "CityPulse/0.1 (https://www.phlpulse.com)" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`Nominatim returned ${res.status}`);
  }

  const data = await readBoundedJsonResponse(res, 2 * 1024 * 1024);
  if (!Array.isArray(data)) throw new Error("Nominatim returned an invalid payload");
  const bounds = cityBounds(city);
  const [[minLng, minLat], [maxLng, maxLat]] = bounds;
  const results: PlaceSearchResult[] = [];
  for (const value of data.slice(0, 100)) {
    const record = asRecord(value);
    if (!record) continue;
    const r = record as NominatimResult;
    const displayName = cleanString(r.display_name);
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    if (!displayName) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;
    const parts = displayName.split(",").map((p) => p.trim()).filter(Boolean);
    const name = parts[0] || displayName;
    const address = parts.slice(1, 4).join(", ") || undefined;
    results.push({
      provider: "nominatim",
      source: "nominatim",
      type: r.type ?? r.class,
      display_name: displayName,
      name,
      address,
      lat,
      lng,
    });
  }
  return results;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const city = cityFromRequest(url);
  const query = cleanString(url.searchParams.get("q"));
  const category = cleanString(url.searchParams.get("category"));
  if (!city) {
    return NextResponse.json({ error: "Unknown city" }, { status: 400 });
  }
  if ((query?.length ?? 0) > 200 || (category?.length ?? 0) > 100) {
    return NextResponse.json({ error: "Search term too long" }, { status: 400 });
  }
  const latRaw = url.searchParams.get("lat");
  const lngRaw = url.searchParams.get("lng");
  if (latRaw !== null || lngRaw !== null) {
    const lat = latRaw === null ? Number.NaN : Number(latRaw);
    const lng = lngRaw === null ? Number.NaN : Number(lngRaw);
    if (!isCoordinatePair([lat, lng])) {
      return NextResponse.json(
        { error: "lat and lng must both be valid decimal-degree coordinates" },
        { status: 400 }
      );
    }
  }
  if (!query && !category) {
    return NextResponse.json({ results: [], meta: { source: "none", city: city.slug } });
  }

  try {
    const tomtom = await searchTomTom(url, city);
    if (tomtom && tomtom.length > 0) {
      return NextResponse.json({
        results: tomtom,
        meta: { source: "tomtom", city: city.slug },
      });
    }
  } catch {
    // Fall through to Nominatim below. Search should degrade instead of
    // blocking the whole map when the traffic provider has a transient issue.
  }

  try {
    const fallback = await searchNominatim(url, city);
    return NextResponse.json({
      results: fallback,
      meta: { source: "nominatim", city: city.slug },
    });
  } catch {
    return NextResponse.json(
      {
        results: [],
        error: "Place search temporarily unavailable",
        meta: { source: "unavailable", city: city.slug },
      },
      { status: 502 }
    );
  }
}
