export function isLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function isCoordinatePair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isLatitude(value[0]) &&
    isLongitude(value[1])
  );
}

/** Parse a user-controlled integer, falling back for malformed values and
 * clamping valid integers to the API's supported range. */
export function parseBoundedInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  const trimmed = value?.trim() ?? "";
  if (!/^-?\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
