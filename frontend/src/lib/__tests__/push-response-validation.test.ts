import { describe, expect, it } from "vitest";
import { normalizePushDevice } from "@/lib/push-subscriptions";

describe("push response validation", () => {
  it("rejects devices without a usable id", () => {
    expect(normalizePushDevice(null)).toBeNull();
    expect(normalizePushDevice({ id: "" })).toBeNull();
    expect(normalizePushDevice({ id: 42 })).toBeNull();
  });

  it("drops malformed alert coordinates and bounds returned metadata", () => {
    const normalized = normalizePushDevice({
      id: "device-1",
      userAgent: "x".repeat(1_100),
      city: "y".repeat(120),
      createdAtMs: -1,
      lastUsedMs: Number.POSITIVE_INFINITY,
      lastNearbyPushMs: 12,
      notifyLat: 999,
      notifyLng: -75.16,
      notifyRadiusKm: 1_000,
      endpointHint: "z".repeat(100),
    });

    expect(normalized).toMatchObject({
      id: "device-1",
      createdAtMs: 0,
      lastUsedMs: 0,
      lastNearbyPushMs: 12,
      notifyLat: null,
      notifyLng: null,
      notifyRadiusKm: null,
    });
    expect(normalized?.userAgent).toHaveLength(1_000);
    expect(normalized?.city).toHaveLength(100);
    expect(normalized?.endpointHint).toHaveLength(64);
  });

  it("keeps valid coordinates and clamps an excessive radius", () => {
    expect(normalizePushDevice({
      id: "device-2",
      notifyLat: 39.95,
      notifyLng: -75.16,
      notifyRadiusKm: 200,
    })).toMatchObject({
      notifyLat: 39.95,
      notifyLng: -75.16,
      notifyRadiusKm: 100,
    });
  });
});
