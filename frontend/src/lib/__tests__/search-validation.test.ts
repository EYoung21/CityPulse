import { beforeEach, describe, expect, it, vi } from "vitest";

describe("place search result validation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("drops malformed coordinates from proxy results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        results: [
          { display_name: "Good", lat: 39.95, lng: -75.16 },
          { display_name: "NaN", lat: Number.NaN, lng: -75.16 },
          { display_name: "Out of range", lat: 999, lng: -75.16 },
        ],
      }), { status: 200 })
    ));
    const { geocodePhilly } = await import("../search");

    const results = await geocodePhilly("city hall");

    expect(results.map((result) => result.display_name)).toEqual(["Good"]);
  });

  it("drops malformed coordinates from direct fallback results", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("proxy down", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { display_name: "Good, Philadelphia", lat: "39.95", lon: "-75.16" },
        { display_name: "Bad", lat: "NaN", lon: "-75.16" },
        { display_name: "Far away", lat: "91", lon: "-75.16" },
      ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { geocodePhilly } = await import("../search");

    const results = await geocodePhilly("city hall");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ lat: 39.95, lng: -75.16 });
  });
});
