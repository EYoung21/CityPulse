/** ~1.1 m at mid-latitudes — enough for float / Firestore rounding drift. */
const COORD_EPSILON = 1e-4;

function roundCoord(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** True when two saved-place coordinates refer to the same spot. */
export function placesMatch(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): boolean {
  if (
    Math.abs(aLat - bLat) < COORD_EPSILON &&
    Math.abs(aLng - bLng) < COORD_EPSILON
  ) {
    return true;
  }
  return roundCoord(aLat) === roundCoord(bLat) && roundCoord(aLng) === roundCoord(bLng);
}
