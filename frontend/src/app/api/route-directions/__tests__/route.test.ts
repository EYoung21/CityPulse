import { describe, expect, it } from "vitest";
import {
  CRASH_BOX_DEG,
  CRASH_ON_ROUTE_M,
  haversineMeters,
  magnitudeToLevel,
  minDistToPathMeters,
  POST,
  selectCrashAvoidanceAreas,
} from "@/app/api/route-directions/route";

describe("route-directions crash helpers", () => {
  const route: [number, number][] = [
    [39.95, -75.17],
    [39.95, -75.165],
    [39.95, -75.16],
  ];

  it("computes haversine distance in meters", () => {
    expect(haversineMeters(39.95, -75.17, 39.951, -75.17)).toBeCloseTo(111, -1);
  });

  it("distinguishes on-route and off-route crash points", () => {
    expect(minDistToPathMeters([39.95, -75.165], route)).toBeLessThan(5);
    expect(minDistToPathMeters([39.951, -75.165], route)).toBeGreaterThan(CRASH_ON_ROUTE_M);
  });

  it("maps TomTom delay magnitude to congestion levels", () => {
    expect(magnitudeToLevel(0)).toBeNull();
    expect(magnitudeToLevel(1)).toBe("moderate");
    expect(magnitudeToLevel(2)).toBe("moderate");
    expect(magnitudeToLevel(3)).toBe("heavy");
    expect(magnitudeToLevel(4)).toBe("severe");
  });

  it("builds avoid rectangles only for crashes on the first-pass route", () => {
    const { onRoute, rects } = selectCrashAvoidanceAreas(
      [
        [39.95, -75.165],
        [39.9512, -75.165],
      ],
      route
    );

    expect(onRoute).toEqual([[39.95, -75.165]]);
    expect(rects).toHaveLength(1);
    expect(rects[0].southWestCorner.latitude).toBeCloseTo(39.95 - CRASH_BOX_DEG);
    expect(rects[0].northEastCorner.longitude).toBeCloseTo(-75.165 + CRASH_BOX_DEG);
  });

  it("caps crash avoid rectangles to TomTom's ten-area limit", () => {
    const candidates = Array.from({ length: 12 }, (_, i) => [39.95, -75.17 + i * 0.0005] as [number, number]);
    const selected = selectCrashAvoidanceAreas(candidates, candidates);
    expect(selected.onRoute).toHaveLength(10);
    expect(selected.rects).toHaveLength(10);
  });

  it("rejects out-of-range waypoints before contacting a provider", async () => {
    const response = await POST(new Request("http://localhost/api/route-directions", {
      method: "POST",
      body: JSON.stringify({ waypoints: [[91, -75], [39.95, -75.16]] }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid waypoint" });
  });

  it("rejects unknown travel modes before contacting a provider", async () => {
    const response = await POST(new Request("http://localhost/api/route-directions", {
      method: "POST",
      body: JSON.stringify({
        waypoints: [[39.95, -75.17], [39.96, -75.16]],
        mode: "teleport",
      }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Unsupported travel mode" });
  });
});
