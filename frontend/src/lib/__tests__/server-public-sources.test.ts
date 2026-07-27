import { describe, expect, it } from "vitest";
import {
  classifyPublicEvent,
  publicCoordinates,
  publicLocation,
} from "@/lib/server-public-sources";

describe("server public-source privacy", () => {
  it("reduces exact locations and coordinate precision", () => {
    expect(publicLocation("2917 Kings Point Rd Apt 4B")).toBe(
      "2900 block Kings Point Rd",
    );
    expect(publicLocation("17TH ST \\ SHOTWELL ST")).toBe(
      "17TH ST & SHOTWELL ST",
    );
    expect(publicCoordinates(35.09736, -85.219751)).toEqual([35.097, -85.22]);
    expect(publicCoordinates(null, null)).toEqual([null, null]);
    expect(publicCoordinates("", "")).toEqual([null, null]);
  });

  it("suppresses sensitive calls and classifies no-weapon fights correctly", () => {
    expect(classifyPublicEvent("juvenile missing")).toBeNull();
    expect(classifyPublicEvent("domestic assault")).toBeNull();
    expect(classifyPublicEvent("FIGHT NO WEAPON")).toBe("violent_no_weapon");
    expect(classifyPublicEvent("structure fire")).toBe("fire_hazmat");
  });
});
