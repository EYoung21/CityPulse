import { isLatitude, isLongitude } from "@/lib/geo-validation";

export type ValidatedLngLatRing = [number, number][];
export type ValidatedLngLatPolygon = ValidatedLngLatRing[];

export interface ValidatedMapRegion {
  name: string;
  slug: string;
  center: { lat: number; lng: number };
  bounds: { north: number; south: number; east: number; west: number };
  polygon?: ValidatedLngLatRing[];
  multiPolygon?: ValidatedLngLatPolygon[];
  neighbors?: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function lngLatPoint(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2 && isLongitude(value[0]) && isLatitude(value[1])
    ? [value[0], value[1]]
    : null;
}

function ring(value: unknown): ValidatedLngLatRing | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > 100_000) return null;
  const points: ValidatedLngLatRing = [];
  for (const rawPoint of value) {
    const point = lngLatPoint(rawPoint);
    if (!point) return null;
    points.push(point);
  }
  return points;
}

function polygon(value: unknown): ValidatedLngLatPolygon | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) return null;
  const rings: ValidatedLngLatPolygon = [];
  for (const rawRing of value) {
    const normalized = ring(rawRing);
    if (!normalized) return null;
    rings.push(normalized);
  }
  return rings;
}

export function normalizeMapRegion(value: unknown): ValidatedMapRegion | null {
  const row = record(value);
  const center = record(row?.center);
  const bounds = record(row?.bounds);
  if (
    !row ||
    typeof row.name !== "string" || !row.name.trim() ||
    typeof row.slug !== "string" || !/^[a-z0-9-]{1,200}$/.test(row.slug) ||
    !center || !isLatitude(center.lat) || !isLongitude(center.lng) ||
    !bounds || !isLatitude(bounds.north) || !isLatitude(bounds.south) ||
    !isLongitude(bounds.east) || !isLongitude(bounds.west) ||
    bounds.north < bounds.south || bounds.east < bounds.west
  ) {
    return null;
  }

  const normalizedPolygon = row.polygon == null ? undefined : polygon(row.polygon);
  if (row.polygon != null && !normalizedPolygon) return null;

  let normalizedMultiPolygon: ValidatedLngLatPolygon[] | undefined;
  if (row.multiPolygon != null) {
    if (!Array.isArray(row.multiPolygon) || row.multiPolygon.length === 0 || row.multiPolygon.length > 10_000) {
      return null;
    }
    normalizedMultiPolygon = [];
    for (const rawPolygon of row.multiPolygon) {
      const normalized = polygon(rawPolygon);
      if (!normalized) return null;
      normalizedMultiPolygon.push(normalized);
    }
  }

  const neighbors = row.neighbors == null
    ? undefined
    : Array.isArray(row.neighbors)
      ? [...new Set(row.neighbors.filter(
          (neighbor): neighbor is string => typeof neighbor === "string" && /^[a-z0-9-]{1,200}$/.test(neighbor),
        ))].slice(0, 500)
      : null;
  if (neighbors === null) return null;

  return {
    name: row.name.trim().slice(0, 200),
    slug: row.slug,
    center: { lat: center.lat, lng: center.lng },
    bounds: {
      north: bounds.north,
      south: bounds.south,
      east: bounds.east,
      west: bounds.west,
    },
    ...(normalizedPolygon ? { polygon: normalizedPolygon } : {}),
    ...(normalizedMultiPolygon ? { multiPolygon: normalizedMultiPolygon } : {}),
    ...(neighbors ? { neighbors } : {}),
  };
}

export function normalizeMapRegions(value: unknown, maxRegions = 2_000): ValidatedMapRegion[] | null {
  if (!Array.isArray(value) || value.length > maxRegions) return null;
  const regions: ValidatedMapRegion[] = [];
  const slugs = new Set<string>();
  for (const rawRegion of value) {
    const region = normalizeMapRegion(rawRegion);
    if (!region || slugs.has(region.slug)) return null;
    slugs.add(region.slug);
    regions.push(region);
  }
  return regions;
}
