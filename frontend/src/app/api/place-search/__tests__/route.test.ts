import { beforeEach, describe, expect, it, vi } from "vitest";

describe("place-search route coordinate handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects partial and out-of-range coordinate bias", async () => {
    const { GET } = await import("../route");
    const partial = await GET(new Request("http://localhost/api/place-search?q=cafe&lat=39.95"));
    const outOfRange = await GET(
      new Request("http://localhost/api/place-search?q=cafe&lat=999&lng=-75.16")
    );

    expect(partial.status).toBe(400);
    expect(outOfRange.status).toBe(400);
  });

  it("rejects unknown cities and oversized search terms", async () => {
    const { GET } = await import("../route");
    const unknownCity = await GET(
      new Request("http://localhost/api/place-search?q=cafe&city=not-a-city")
    );
    const oversized = await GET(
      new Request(`http://localhost/api/place-search?q=${"a".repeat(201)}`)
    );

    expect(unknownCity.status).toBe(400);
    expect(oversized.status).toBe(400);
  });

  it("uses the city center when coordinate bias is absent", async () => {
    vi.stubEnv("TOMTOM_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{
        id: "poi-1",
        position: { lat: 39.9526, lon: -75.1652 },
        poi: { name: "Cafe" },
      }] }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("../route");
    const response = await GET(new Request("http://localhost/api/place-search?q=cafe&city=philly"));

    expect(response.status).toBe(200);
    const upstream = new URL(String(fetchMock.mock.calls[0][0]));
    expect(upstream.searchParams.get("lat")).toBe("39.952600");
    expect(upstream.searchParams.get("lon")).toBe("-75.165200");
  });

  it("reports an upstream fallback outage instead of an empty success", async () => {
    vi.stubEnv("TOMTOM_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("busy", { status: 503 })));

    const { GET } = await import("../route");
    const response = await GET(new Request("http://localhost/api/place-search?q=cafe"));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("Place search temporarily unavailable");
  });
});
