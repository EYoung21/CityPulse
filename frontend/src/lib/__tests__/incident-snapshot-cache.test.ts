import { beforeEach, describe, expect, it } from "vitest";
import { loadCachedIncidents } from "@/lib/incident-snapshot-cache";

const KEY = "pp:incidents:v1:philly";

describe("incident snapshot cache", () => {
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
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
  });

  it("filters and normalizes malformed cached incident rows", () => {
    localStorage.setItem(KEY, JSON.stringify({
      savedAt: Date.now(),
      city: "philly",
      incidents: ["bad", { id: "cached", lat: Number.NaN, lng: -75.16, confidence: 2 }],
    }));

    expect(loadCachedIncidents("philly")?.incidents).toEqual([
      expect.objectContaining({ id: "cached", lat: null, lng: null, confidence: 0 }),
    ]);
  });

  it("rejects non-finite and implausibly future cache timestamps", () => {
    for (const savedAt of [Number.NaN, Date.now() + 120_000]) {
      localStorage.setItem(KEY, JSON.stringify({ savedAt, city: "philly", incidents: [] }));
      expect(loadCachedIncidents("philly")).toBeNull();
    }
  });
});
