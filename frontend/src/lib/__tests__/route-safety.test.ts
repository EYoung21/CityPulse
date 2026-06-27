import { describe, expect, it } from "vitest";
import type { Incident } from "@/lib/api";
import { scoreRouteOptions, scoreRouteSafety } from "@/lib/route-safety";

function inc(overrides: Partial<Incident>): Incident {
  return {
    id: "inc",
    reported_at: "2026-01-01T00:00:00.000Z",
    raw_text: "",
    severity_category: "violent_weapon",
    s_base: 0.8,
    confidence: 0.9,
    inhibitor_status: "passed",
    ...overrides,
  } as Incident;
}

describe("scoreRouteSafety", () => {
  const route: [number, number][] = [
    [39.95, -75.17],
    [39.95, -75.16],
  ];

  it("returns zeroes for empty geometry or empty incident lists", () => {
    expect(scoreRouteSafety([], [inc({ lat: 39.95, lng: -75.17 })])).toMatchObject({
      count: 0,
      weighted: 0,
    });
    expect(scoreRouteSafety(route, [])).toMatchObject({ count: 0, weighted: 0 });
  });

  it("counts incidents inside the route corridor and excludes points just outside", () => {
    const score = scoreRouteSafety(
      route,
      [
        inc({ id: "inside", lat: 39.95045, lng: -75.165, severity_category: "traffic_crash_injury" }),
        inc({ id: "edge", lat: 39.95088, lng: -75.165, severity_category: "fire_hazmat" }),
        inc({ id: "outside", lat: 39.9511, lng: -75.165, severity_category: "violent_weapon" }),
      ],
      100
    );

    expect(score.count).toBe(2);
    expect(score.bySeverity.traffic).toBe(1);
    expect(score.bySeverity.fire).toBe(1);
    expect(score.bySeverity.violent).toBe(0);
    expect(score.weighted).toBeCloseTo(2.0);
  });

  it("uses the supplied margin when deciding corridor exposure", () => {
    const incidents = [inc({ lat: 39.9507, lng: -75.165 })];
    expect(scoreRouteSafety(route, incidents, 60).count).toBe(0);
    expect(scoreRouteSafety(route, incidents, 90).count).toBe(1);
  });

  it("skips incidents without coordinates", () => {
    expect(scoreRouteSafety(route, [inc({ lat: null, lng: -75.165 })], 120).count).toBe(0);
  });
});

describe("scoreRouteOptions", () => {
  it("scores each option by id", () => {
    const options = [
      { id: "fast", route: { geometry: [[39.95, -75.17], [39.95, -75.16]] as [number, number][] } },
      { id: "safe", route: { geometry: [[39.96, -75.17], [39.96, -75.16]] as [number, number][] } },
    ];
    const scores = scoreRouteOptions(options, [inc({ lat: 39.95, lng: -75.165 })], 120);
    expect(scores.get("fast")?.count).toBe(1);
    expect(scores.get("safe")?.count).toBe(0);
  });
});
