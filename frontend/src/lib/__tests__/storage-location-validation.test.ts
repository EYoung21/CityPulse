import { beforeEach, describe, expect, it } from "vitest";
import { getParkedPin, setParkedPin } from "@/lib/parked-pin";
import { loadRecent, pushRecent } from "@/lib/recent-searches";
import { loadTripSnapshot, updateTripProgress } from "@/lib/trip-resume";

beforeEach(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});

describe("location-bearing browser storage validation", () => {
  it("removes structurally invalid trip-resume snapshots", () => {
    localStorage.setItem("pp:trip-resume-v1", JSON.stringify({
      origin: { display_name: "Bad", lat: 999, lng: -75 },
      dest: { display_name: "Good", lat: 39.95, lng: -75.16 },
      stops: [],
      mode: "foot-walking",
      startedAt: Date.now(),
      progress: 0,
    }));

    expect(loadTripSnapshot()).toBeNull();
    expect(localStorage.getItem("pp:trip-resume-v1")).toBeNull();
  });

  it("normalizes valid trip progress and ignores non-finite updates", () => {
    localStorage.setItem("pp:trip-resume-v1", JSON.stringify({
      origin: { display_name: "A", lat: 39.95, lng: -75.16 },
      dest: { display_name: "B", lat: 39.96, lng: -75.17 },
      stops: [],
      mode: "foot-walking",
      startedAt: Date.now(),
      progress: 0.5,
    }));

    expect(loadTripSnapshot()?.progress).toBe(0.5);
    updateTripProgress(Number.POSITIVE_INFINITY);
    expect(loadTripSnapshot()?.progress).toBe(0.5);
  });

  it("rejects impossible parked pins and bounds stored text", () => {
    localStorage.setItem("pp:parked-pin-v1", JSON.stringify({ lat: 91, lng: 0, ts: Date.now() }));
    expect(getParkedPin()).toBeNull();
    expect(localStorage.getItem("pp:parked-pin-v1")).toBeNull();

    const pin = setParkedPin({ lat: 39.95, lng: -75.16, note: "x".repeat(700) });
    expect(pin?.note).toHaveLength(500);
    expect(setParkedPin({ lat: Number.NaN, lng: 0 })).toBeNull();
  });

  it("filters corrupt recent searches and refuses invalid new coordinates", () => {
    localStorage.setItem("pp:recent-searches", JSON.stringify([
      { display_name: "Bad", lat: 999, lng: 0, at: Date.now() },
      { display_name: "Good", lat: 39.95, lng: -75.16, at: Date.now() },
    ]));
    expect(loadRecent()).toEqual([expect.objectContaining({ display_name: "Good" })]);
    expect(pushRecent({ display_name: "Nope", lat: Number.NaN, lng: 0 })).toHaveLength(1);
  });
});
