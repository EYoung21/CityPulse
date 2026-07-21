import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNearbyPois, fetchPlaceAtPoint } from "@/lib/overpass";

function overpassKey(category: string, lat: number, lng: number, radius: number): string {
  return `pp:overpass:${category}:${lat.toFixed(4)},${lng.toFixed(4)}:${radius}`;
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Overpass cache validation", () => {
  it("discards a malformed POI cache instead of throwing", async () => {
    const lat = 39.9111;
    const lng = -75.1711;
    const radius = 777;
    sessionStorage.setItem(
      overpassKey("food", lat, lng, radius),
      JSON.stringify({ at: Date.now(), data: { not: "an array" } })
    );

    await expect(fetchNearbyPois("food", lat, lng, radius, 8)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(overpassKey("food", lat, lng, radius))).not.toContain("not");
  });

  it("revalidates cached third-party URLs before rendering them", async () => {
    const lat = 39.9222;
    const lng = -75.1822;
    const radius = 778;
    sessionStorage.setItem(
      overpassKey("food", lat, lng, radius),
      JSON.stringify({
        at: Date.now(),
        data: [{
          id: "node/1",
          name: "Cached cafe",
          category: "food",
          lat,
          lng,
          distance: 12,
          website: "javascript:alert(1)",
        }],
      })
    );

    const rows = await fetchNearbyPois("food", lat, lng, radius, 8);
    expect(rows).toHaveLength(1);
    expect(rows[0].website).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("filters impossible coordinates returned by the upstream service", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        elements: [{ type: "node", id: 7, lat: 999, lon: -75.1, tags: { name: "Impossible" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    );

    await expect(fetchNearbyPois("coffee", 39.9333, -75.1933, 779, 8)).resolves.toEqual([]);
  });

  it("discards malformed place-at-point cache entries", async () => {
    const lat = 39.94444;
    const lng = -75.20444;
    const radius = 31;
    const key = `pp:overpass:place:${lat.toFixed(5)},${lng.toFixed(5)}:${radius}`;
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data: { lat: "bad" } }));

    await expect(fetchPlaceAtPoint(lat, lng, radius)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(sessionStorage.getItem(key) ?? "null")).toEqual(
      expect.objectContaining({ data: null })
    );
  });
});
