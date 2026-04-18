import { OpenLocationCode } from "open-location-code";

const olc = new OpenLocationCode();

/** Full 10-character Plus Code (~14m precision) for the given lat/lng. */
export function plusCode(lat: number, lng: number, length = 10): string {
  try {
    return olc.encode(lat, lng, length);
  } catch {
    return "";
  }
}
