import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeMapRegion, normalizeMapRegions } from "@/lib/map-region-validation";

const validRegion = {
  name: "Center City",
  slug: "center-city",
  center: { lat: 39.95, lng: -75.16 },
  bounds: { north: 40, south: 39.9, east: -75.1, west: -75.2 },
  polygon: [[[-75.2, 39.9], [-75.1, 39.9], [-75.1, 40], [-75.2, 39.9]]],
};

describe("map region validation", () => {
  it("accepts valid regions and deduplicates neighbor slugs", () => {
    expect(normalizeMapRegion({
      ...validRegion,
      neighbors: ["north", "north", 42],
    })).toMatchObject({
      slug: "center-city",
      neighbors: ["north"],
    });
  });

  it("rejects impossible geometry and duplicate region slugs", () => {
    expect(normalizeMapRegion({
      ...validRegion,
      polygon: [[[999, 39.9], [-75.1, 39.9], [-75.1, 40]]],
    })).toBeNull();
    expect(normalizeMapRegion({
      ...validRegion,
      bounds: { north: 39, south: 40, east: -75.1, west: -75.2 },
    })).toBeNull();
    expect(normalizeMapRegions([validRegion, validRegion])).toBeNull();
  });

  it("accepts every shipped district and neighborhood asset", () => {
    for (const directory of ["districts", "neighborhoods"]) {
      const assetDirectory = resolve(process.cwd(), "public", directory);
      for (const filename of readdirSync(assetDirectory).filter((name) => name.endsWith(".json"))) {
        const raw = JSON.parse(readFileSync(resolve(assetDirectory, filename), "utf8")) as unknown;
        expect(normalizeMapRegions(raw), `${directory}/${filename}`).not.toBeNull();
      }
    }
  });
});
