import { isCoordinatePair } from "@/lib/geo-validation";

export type SearchParamValue = string | string[] | undefined;

export function singleSearchParam(value: SearchParamValue, maxLength: number): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

export function strictSingleSearchParam(
  value: SearchParamValue,
  maxLength: number,
): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

export interface NormalizedIncidentShareParams {
  incident?: string;
  lat?: string;
  lng?: string;
  zoom?: string;
  t?: string;
  c?: string;
  loc?: string;
  time?: string;
}

export type IncidentShareParamInput = {
  [Key in keyof NormalizedIncidentShareParams]?: SearchParamValue;
};

export function normalizeIncidentShareParams(
  params: IncidentShareParamInput,
): NormalizedIncidentShareParams {
  const incidentRaw = singleSearchParam(params.incident, 200);
  const incident = incidentRaw && /^[A-Za-z0-9_-]{1,200}$/.test(incidentRaw)
    ? incidentRaw
    : undefined;

  const latRaw = singleSearchParam(params.lat, 32);
  const lngRaw = singleSearchParam(params.lng, 32);
  const lat = latRaw === undefined ? Number.NaN : Number(latRaw);
  const lng = lngRaw === undefined ? Number.NaN : Number(lngRaw);
  const coordinates = isCoordinatePair([lat, lng])
    ? { lat: String(lat), lng: String(lng) }
    : {};

  const zoomRaw = singleSearchParam(params.zoom, 16);
  const zoomNumber = zoomRaw === undefined ? Number.NaN : Number(zoomRaw);
  const zoom = Number.isFinite(zoomNumber) && zoomNumber >= 1 && zoomNumber <= 22
    ? String(zoomNumber)
    : undefined;

  return {
    incident,
    ...coordinates,
    zoom,
    t: singleSearchParam(params.t, 160),
    c: singleSearchParam(params.c, 64),
    loc: singleSearchParam(params.loc, 240),
    time: singleSearchParam(params.time, 64),
  };
}
