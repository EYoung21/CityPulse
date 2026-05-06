import type { Incident } from "./api";
import { getCurrentCity } from "./pulse-cities";

export type LngLatRing = [number, number][];
export type LngLatPolygon = LngLatRing[];

export interface District {
  name: string;
  slug: string;
  center: { lat: number; lng: number };
  bounds: { north: number; south: number; east: number; west: number };
  polygon?: LngLatRing[];
  multiPolygon?: LngLatPolygon[];
}

const CITY_DISTRICTS: Record<string, District[]> = {
  philly: [],
  sf: [],
  nyc: [],
  chattanooga: [],
  cle: [],
  cha: [],
  charlotte: [],
};

const CITIES_WITH_LAZY_DATA = new Set<string>(["sf", "nyc", "philly", "chattanooga"]);
const _loadPromises: Record<string, Promise<District[]> | undefined> = {};
const _loadListeners = new Set<(slug: string) => void>();

export function onCityDistrictsLoaded(cb: (slug: string) => void): () => void {
  _loadListeners.add(cb);
  return () => {
    _loadListeners.delete(cb);
  };
}

function _emitLoaded(slug: string) {
  for (const cb of _loadListeners) {
    try {
      cb(slug);
    } catch {
      /* listener errors should not break the load pipeline */
    }
  }
}

export function loadCityDistricts(slug: string): Promise<District[]> {
  if (typeof window === "undefined") {
    return Promise.resolve(CITY_DISTRICTS[slug] || []);
  }
  if ((CITY_DISTRICTS[slug] || []).length > 0) {
    return Promise.resolve(CITY_DISTRICTS[slug]);
  }
  if (!CITIES_WITH_LAZY_DATA.has(slug)) {
    return Promise.resolve(CITY_DISTRICTS[slug] || []);
  }
  const existing = _loadPromises[slug];
  if (existing) return existing;

  const p = fetch(`/districts/${slug}.json`, { cache: "force-cache" })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} loading ${slug}.json`);
      return res.json();
    })
    .then((data: District[]) => {
      if (!Array.isArray(data)) throw new Error("expected array");
      CITY_DISTRICTS[slug] = data;
      _emitLoaded(slug);
      return data;
    })
    .catch((err) => {
      delete _loadPromises[slug];
      if (typeof console !== "undefined") {
        // eslint-disable-next-line no-console
        console.warn(`[districts] failed to load ${slug}:`, err);
      }
      return CITY_DISTRICTS[slug] || [];
    });

  _loadPromises[slug] = p;
  return p;
}

function activeDistricts(): District[] {
  try {
    return CITY_DISTRICTS[getCurrentCity().slug] || [];
  } catch {
    return [];
  }
}

export function getDistrictsForCity(citySlug: string): District[] {
  return CITY_DISTRICTS[citySlug] || [];
}

export const DISTRICTS: District[] = new Proxy([] as District[], {
  get(_target, prop, receiver) {
    return Reflect.get(activeDistricts(), prop, receiver);
  },
  has(_target, prop) {
    return prop in activeDistricts();
  },
  ownKeys() {
    return Reflect.ownKeys(activeDistricts());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(activeDistricts(), prop);
  },
});

function pointInRing(lat: number, lng: number, ring: LngLatRing): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInDistrict(d: District, lat: number, lng: number): boolean {
  if (
    (d.multiPolygon && d.multiPolygon.length > 0) ||
    (d.polygon && d.polygon.length > 0)
  ) {
    if (
      lat < d.bounds.south ||
      lat > d.bounds.north ||
      lng < d.bounds.west ||
      lng > d.bounds.east
    ) {
      return false;
    }
    if (d.multiPolygon && d.multiPolygon.length > 0) {
      for (const polygon of d.multiPolygon) {
        if (polygon.length === 0 || !pointInRing(lat, lng, polygon[0])) continue;
        const inHole = polygon.slice(1).some((hole) => pointInRing(lat, lng, hole));
        if (!inHole) return true;
      }
      return false;
    }
    for (const ring of d.polygon || []) {
      if (pointInRing(lat, lng, ring)) return true;
    }
    return false;
  }
  return (
    lat >= d.bounds.south &&
    lat <= d.bounds.north &&
    lng >= d.bounds.west &&
    lng <= d.bounds.east
  );
}

export function getDistrictBySlug(slug: string): District | null {
  return activeDistricts().find((d) => d.slug === slug) ?? null;
}

export function incidentsInDistrict(incidents: Incident[], slug: string): Incident[] {
  const district = getDistrictBySlug(slug);
  if (!district) return [];
  return incidents.filter(
    (i) => i.lat != null && i.lng != null && pointInDistrict(district, i.lat!, i.lng!)
  );
}
