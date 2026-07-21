import { describe, expect, it } from "vitest";
import {
  isCoordinatePair,
  parseBoundedInteger,
} from "@/lib/geo-validation";

describe("geographic request validation", () => {
  it("accepts finite in-range latitude/longitude pairs", () => {
    expect(isCoordinatePair([39.9526, -75.1652])).toBe(true);
    expect(isCoordinatePair([-90, 180])).toBe(true);
  });

  it("rejects non-finite, out-of-range, and non-numeric pairs", () => {
    expect(isCoordinatePair([91, -75])).toBe(false);
    expect(isCoordinatePair([39, -181])).toBe(false);
    expect(isCoordinatePair([Number.POSITIVE_INFINITY, -75])).toBe(false);
    expect(isCoordinatePair(["39", "-75"])).toBe(false);
  });

  it("defaults malformed integers and clamps valid ones", () => {
    expect(parseBoundedInteger("oops", 25, 1, 50)).toBe(25);
    expect(parseBoundedInteger("2.5", 25, 1, 50)).toBe(25);
    expect(parseBoundedInteger("500", 25, 1, 50)).toBe(50);
    expect(parseBoundedInteger("0", 25, 1, 50)).toBe(1);
  });
});
