import { NextResponse } from "next/server";

/** OpenStreetMap POI proxy.
 *
 *    /api/poi?category=coffee&lat=39.95&lng=-75.16&radius=2500&limit=25
 *
 *  Wraps the Overpass API. We cache aggressively (5 min) because
 *  Overpass is a community-funded shared resource and POI data
 *  doesn't change minute-to-minute. */

const CACHE_TTL = 300; // 5 min — POI tags don't change often

// Tried in order on failure. The kumi instance often holds when the
// main one is overloaded.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

interface CategoryDef {
  key: string;
  tags: string[];
}

const CATEGORIES: Record<string, CategoryDef> = {
  coffee:   { key: "coffee",   tags: ["amenity=cafe"] },
  food:     { key: "food",     tags: ["amenity=restaurant", "amenity=fast_food"] },
  hospital: { key: "hospital", tags: ["amenity=hospital"] },
  pharmacy: { key: "pharmacy", tags: ["amenity=pharmacy"] },
  gas:      { key: "gas",      tags: ["amenity=fuel"] },
  parking:  { key: "parking",  tags: ["amenity=parking"] },
  atm:      { key: "atm",      tags: ["amenity=atm", "amenity=bank"] },
  transit:  { key: "transit",  tags: ["public_transport=station", "railway=station"] },
};

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

function buildQuery(tags: string[], lat: number, lng: number, radiusM: number): string {
  // Around-radius filter is the cleanest way to ask Overpass for
  // "things within X meters of a point" without juggling a bbox.
  const filters = tags
    .map((t) => {
      const [k, v] = t.split("=");
      // around: <radius>, <lat>, <lng>
      return `node["${k}"="${v}"](around:${radiusM},${lat},${lng});
              way["${k}"="${v}"](around:${radiusM},${lat},${lng});`;
    })
    .join("");
  return `[out:json][timeout:15];(${filters});out center 50;`;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchOverpass(query: string, signal?: AbortSignal): Promise<OverpassResponse> {
  let lastErr: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "CityPulse/0.1 (https://www.phlpulse.com)",
        },
        body: `data=${encodeURIComponent(query)}`,
        next: { revalidate: CACHE_TTL },
        signal,
      });
      if (!r.ok) {
        lastErr = new Error(`${endpoint} → HTTP ${r.status}`);
        continue;
      }
      return (await r.json()) as OverpassResponse;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr ?? new Error("all Overpass endpoints failed");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const categoryKey = url.searchParams.get("category") || "";
  const lat = parseFloat(url.searchParams.get("lat") || "");
  const lng = parseFloat(url.searchParams.get("lng") || "");
  const radius = Math.min(
    10_000,
    Math.max(100, parseInt(url.searchParams.get("radius") || "2500", 10))
  );
  const limit = Math.min(
    50,
    Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10))
  );

  const cat = CATEGORIES[categoryKey];
  if (!cat) {
    return NextResponse.json(
      { error: `unknown category: ${categoryKey}` },
      { status: 400 }
    );
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      { error: "lat and lng required (decimal degrees)" },
      { status: 400 }
    );
  }

  try {
    const data = await fetchOverpass(buildQuery(cat.tags, lat, lng, radius));
    const results = (data.elements ?? [])
      .map((el) => {
        const elLat = el.lat ?? el.center?.lat;
        const elLng = el.lon ?? el.center?.lon;
        if (elLat == null || elLng == null) return null;
        const name = el.tags?.name?.trim() || "";
        const street = el.tags?.["addr:street"]?.trim() || "";
        const houseNo = el.tags?.["addr:housenumber"]?.trim() || "";
        const subtitle = [houseNo, street].filter(Boolean).join(" ") || undefined;
        return {
          name: name || categoryKey,
          lat: elLat,
          lng: elLng,
          subtitle,
          meters: Math.round(haversineM(lat, lng, elLat, elLng)),
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => (a.meters ?? 0) - (b.meters ?? 0))
      .slice(0, limit);

    return NextResponse.json({
      results,
      meta: { category: categoryKey, count: results.length, radius_m: radius },
    });
  } catch (e) {
    return NextResponse.json(
      {
        results: [],
        error: e instanceof Error ? e.message : "Overpass proxy failed",
        meta: { category: categoryKey, count: 0 },
      },
      { status: 502 }
    );
  }
}
