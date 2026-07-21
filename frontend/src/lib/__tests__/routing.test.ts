import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Incident } from "@/lib/api";
import {
  buildAvoidPolygons,
  buildAvoidZones,
  circleToPolygon,
  defaultAvoidancePrefs,
  filterRouteOptionsForSafestOnlyUi,
  geometriesAreSimilar,
  isTransitMode,
  mergeRouteLegs,
  normalizeAvoidancePrefs,
  orsProfile,
  type AvoidancePrefs,
  type RouteOption,
} from "@/lib/routing";

function inc(overrides: Partial<Incident>): Incident {
  return {
    id: "inc",
    reported_at: "2026-01-01T12:00:00.000Z",
    raw_text: "",
    severity_category: "violent_weapon",
    s_base: 0.8,
    confidence: 0.9,
    inhibitor_status: "passed",
    lat: 39.95,
    lng: -75.16,
    w_eff: 0.8,
    ...overrides,
  } as Incident;
}

describe("avoidance preferences", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to avoiding violent and fire categories with the low floor", () => {
    const prefs = defaultAvoidancePrefs();
    expect(prefs.minSeverity).toBe("low");
    expect(prefs.maxAgeHours).toBeUndefined();
    expect(prefs.leaves.has("violent_weapon")).toBe(true);
    expect(prefs.leaves.has("fire_hazmat")).toBe(true);
    expect(prefs.leaves.has("traffic_crash_injury")).toBe(false);
  });

  it("buildAvoidZones filters by category, severity, age, and coordinates", () => {
    const prefs: AvoidancePrefs = {
      leaves: new Set(["violent_weapon", "traffic_crash_injury"]),
      minSeverity: "medium",
      maxAgeHours: 2,
    };

    const zones = buildAvoidZones(
      [
        inc({ id: "violent", severity_category: "violent_weapon", w_eff: 0.75 }),
        inc({ id: "traffic", severity_category: "traffic_crash_injury", w_eff: 0.5, lat: 39.96, lng: -75.17 }),
        inc({ id: "too-low", severity_category: "violent_weapon", w_eff: 0.49 }),
        inc({ id: "old", severity_category: "violent_weapon", w_eff: 0.8, reported_at: "2026-01-01T08:59:00.000Z" }),
        inc({ id: "wrong-cat", severity_category: "medical_priority", w_eff: 0.9 }),
        inc({ id: "no-coords", severity_category: "violent_weapon", w_eff: 0.9, lat: null, lng: -75.17 }),
      ],
      prefs
    );

    expect(zones).toHaveLength(2);
    expect(zones[0]).toMatchObject({ center: [39.95, -75.16], radiusM: 300 });
    expect(zones[1]).toMatchObject({ center: [39.96, -75.17], radiusM: 250 });
  });

  it("treats an empty leaf set as avoidance turned off", () => {
    const zones = buildAvoidZones(
      [
        inc({ severity_category: "medical_priority", w_eff: 0.5 }),
        inc({ severity_category: "traffic_crash_no_injury", w_eff: 0.2 }),
      ],
      { leaves: new Set(), minSeverity: "low" }
    );
    expect(zones).toHaveLength(0);
  });

  it("normalizes stored leaves and preserves the routing time horizon", () => {
    const prefs = normalizeAvoidancePrefs({
      leaves: ["violent_weapon", "not_a_category", 42],
      minSeverity: "high",
      maxAgeHours: 6,
    });
    expect([...prefs.leaves]).toEqual(["violent_weapon"]);
    expect(prefs.minSeverity).toBe("high");
    expect(prefs.maxAgeHours).toBe(6);

    const off = normalizeAvoidancePrefs({ leaves: [], minSeverity: "any", maxAgeHours: 999 });
    expect(off.leaves.size).toBe(0);
    expect(off.maxAgeHours).toBeUndefined();
  });
});

describe("avoid polygons and route helpers", () => {
  it("builds closed circle polygons and multipolygons", () => {
    const ring = circleToPolygon(39.95, -75.16, 100, 8);
    expect(ring).toHaveLength(9);
    expect(ring[0][0]).toBeCloseTo(ring[8][0]);
    expect(ring[0][1]).toBeCloseTo(ring[8][1]);

    const multi = buildAvoidPolygons([{ center: [39.95, -75.16], radiusM: 100 }]);
    expect(multi?.type).toBe("MultiPolygon");
    expect(multi?.coordinates).toHaveLength(1);
  });

  it("filters route options to safer options when safest-only UI is enabled", () => {
    const fastest = option("fastest", false, 10);
    const safer = option("safer", true, 12);
    expect(filterRouteOptionsForSafestOnlyUi([fastest, safer])).toEqual([safer]);
    expect(filterRouteOptionsForSafestOnlyUi([fastest])).toEqual([fastest]);
  });

  it("maps transit modes to walking ORS profiles and detects transit modes", () => {
    expect(orsProfile("transit-train")).toBe("foot-walking");
    expect(orsProfile("driving-car")).toBe("driving-car");
    expect(isTransitMode("transit-subway")).toBe(true);
    expect(isTransitMode("cycling-regular")).toBe(false);
  });

  it("detects similar geometries on a rounded grid", () => {
    expect(
      geometriesAreSimilar(
        [[39.95001, -75.16001], [39.95101, -75.16101]],
        [[39.95002, -75.16002], [39.95102, -75.16102]]
      )
    ).toBe(true);
    expect(
      geometriesAreSimilar(
        [[39.95, -75.16], [39.951, -75.161]],
        [[40.1, -75.3], [40.101, -75.301]]
      )
    ).toBe(false);
  });

  it("merges route legs without duplicating seam points", () => {
    expect(
      mergeRouteLegs([
        [[1, 1], [2, 2]],
        [[2, 2], [3, 3]],
      ])
    ).toEqual([[1, 1], [2, 2], [3, 3]]);
  });
});

function option(id: string, isSafer: boolean, durationMin: number): RouteOption {
  return {
    id,
    label: id,
    route: {
      geometry: [[39.95, -75.16], [39.96, -75.17]],
      distanceKm: 1,
      durationMin,
      isSafe: isSafer,
    },
    isSafer,
    avoidedFeatures: [],
  };
}
