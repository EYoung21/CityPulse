import type { Incident } from "./api";
import { getCurrentCity } from "./pulse-cities";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

export interface GeoResult {
  display_name: string;
  lat: number;
  lng: number;
  id?: string;
  entityId?: string;
  name?: string;
  address?: string;
  category?: string;
  categories?: string[];
  source?: "tomtom" | "nominatim";
  provider?: "tomtom" | "nominatim";
  type?: string;
  phone?: string;
  website?: string;
  openingHours?: unknown;
  distanceM?: number;
  score?: number;
}

/** Reverse geocode lat/lng → human-readable address via Nominatim. Returns
 * a short label (street + neighborhood) or null on failure. Caller should
 * fall back to "lat, lng" if null. */
export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      lat: lat.toFixed(6),
      lon: lng.toFixed(6),
      format: "jsonv2",
      zoom: "18",
      addressdetails: "1",
    });
    const res = await fetch(`${NOMINATIM_REVERSE_URL}?${params}`, {
      headers: { "User-Agent": "PHLPulse/0.1" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      display_name?: string;
      address?: Record<string, string | undefined>;
    };
    const a = data.address ?? {};
    const street = [a.house_number, a.road].filter(Boolean).join(" ");
    const area =
      a.neighbourhood || a.suburb || a.city_district || a.town || a.city || "";
    if (street && area) return `${street}, ${area}`;
    if (street) return street;
    if (area) return area;
    return data.display_name?.split(",").slice(0, 2).join(",").trim() ?? null;
  } catch {
    return null;
  }
}

export interface SafetyResult {
  location: GeoResult;
  nearbyCount: number;
  avgSeverity: number;
  riskLevel: "low" | "moderate" | "elevated" | "high";
  riskColor: string;
  nearbyIncidents: Incident[];
}

export async function geocodePhilly(
  query: string,
  opts: { lat?: number; lng?: number; limit?: number; category?: string } = {}
): Promise<GeoResult[]> {
  if (!query.trim()) return [];

  const city = getCurrentCity();

  if (typeof window !== "undefined") {
    const params = new URLSearchParams({
      q: query,
      city: city.slug,
      limit: String(opts.limit ?? 8),
    });
    if (opts.category) params.set("category", opts.category);
    if (Number.isFinite(opts.lat)) params.set("lat", String(opts.lat));
    if (Number.isFinite(opts.lng)) params.set("lng", String(opts.lng));

    try {
      const res = await fetch(`/api/place-search?${params}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as { results?: GeoResult[] };
        if (Array.isArray(data.results)) return data.results;
      }
    } catch {
      // Fall through to the direct Nominatim path below. This keeps
      // search useful during local Next API hiccups.
    }
  }

  const nameLower = city.name.toLowerCase();
  const q = query.toLowerCase().includes(nameLower) ? query : `${query}${city.geocodeSuffix}`;

  const params = new URLSearchParams({
    q,
    format: "json",
    limit: "5",
    viewbox: city.nominatimViewbox,
    bounded: "1",
  });

  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { "User-Agent": "PHLPulse/0.1" },
  });
  if (!res.ok) return [];

  const data = await res.json();
  return data.map((r: { display_name: string; lat: string; lon: string; type?: string }) => {
    const parts = r.display_name.split(",").map((p) => p.trim()).filter(Boolean);
    return {
      display_name: r.display_name,
      name: parts[0],
      address: parts.slice(1, 4).join(", ") || undefined,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      source: "nominatim" as const,
      provider: "nominatim" as const,
      type: r.type,
    };
  });
}

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function assessSafety(
  location: GeoResult,
  incidents: Incident[],
  radiusKm = 1.0
): SafetyResult {
  const nearby = incidents.filter(
    (inc) =>
      inc.lat != null &&
      inc.lng != null &&
      haversineKm(location.lat, location.lng, inc.lat!, inc.lng!) <= radiusKm
  );

  const avgSeverity =
    nearby.length > 0
      ? nearby.reduce((sum, inc) => sum + inc.s_base, 0) / nearby.length
      : 0;

  let riskLevel: SafetyResult["riskLevel"];
  let riskColor: string;

  if (nearby.length === 0) {
    riskLevel = "low";
    riskColor = "#22c55e";
  } else if (nearby.length <= 2 && avgSeverity < 0.5) {
    riskLevel = "moderate";
    riskColor = "#eab308";
  } else if (nearby.length <= 5) {
    riskLevel = "elevated";
    riskColor = "#f97316";
  } else {
    riskLevel = "high";
    riskColor = "#ef4444";
  }

  return {
    location,
    nearbyCount: nearby.length,
    avgSeverity,
    riskLevel,
    riskColor,
    nearbyIncidents: nearby,
  };
}
