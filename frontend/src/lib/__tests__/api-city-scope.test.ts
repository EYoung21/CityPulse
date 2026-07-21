import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPublicApi: vi.fn(),
}));

vi.mock("@/lib/public-api-base", () => ({
  fetchPublicApi: mocks.fetchPublicApi,
}));

vi.mock("@/lib/firebase", () => ({
  isFirebaseConfigured: () => false,
  getFirebaseApp: vi.fn(),
}));

vi.mock("@/lib/pulse-cities", () => ({
  getCurrentCity: () => ({ slug: "sf" }),
}));

vi.mock("@/lib/upgrade", () => ({ requestUpgrade: vi.fn() }));

import {
  fetchIncidentPage,
  fetchIncidents,
  fetchStats,
  fetchSummary,
  searchIncidentsApi,
} from "@/lib/api";

describe("city-scoped REST fallbacks", () => {
  beforeEach(() => {
    mocks.fetchPublicApi.mockReset();
    mocks.fetchPublicApi.mockImplementation((url: string) => {
      const payload = url.startsWith("/api/incidents/page")
        ? { incidents: [], next_cursor: null, mode: "recent" }
        : url.startsWith("/api/incidents/search")
          ? { results: [], total: 0, query: "test" }
          : url.startsWith("/api/incidents")
            ? { incidents: [] }
        : url.startsWith("/api/summary")
          ? { summary: "City summary", incident_count: 0 }
          : { total_incidents: 0, inhibitor_stats: {} };
      return Promise.resolve(Response.json(payload));
    });
  });

  it("includes the active city in incident, summary, and stats requests", async () => {
    await fetchIncidents();
    await fetchIncidentPage({});
    await searchIncidentsApi({ q: "test" });
    await fetchSummary();
    await fetchStats();

    expect(mocks.fetchPublicApi.mock.calls.map(([url]) => url)).toEqual([
      "/api/incidents?city=sf",
      "/api/incidents/page?city=sf",
      "/api/incidents/search?q=test&city=sf",
      "/api/summary?city=sf",
      "/api/stats?city=sf",
    ]);
  });

  it("allows an explicit city override", async () => {
    await fetchIncidents(undefined, undefined, "philly");
    await fetchIncidentPage({ city: "philly" });
    await searchIncidentsApi({ q: "test", city: "philly" });
    await fetchSummary("philly");
    await fetchStats("philly");

    expect(mocks.fetchPublicApi.mock.calls.map(([url]) => url)).toEqual([
      "/api/incidents?city=philly",
      "/api/incidents/page?city=philly",
      "/api/incidents/search?q=test&city=philly",
      "/api/summary?city=philly",
      "/api/stats?city=philly",
    ]);
  });

  it("normalizes malformed incident rows at every REST boundary", async () => {
    const malformed = { id: "qa", lat: 39.95, lng: 999, confidence: 9, distance_km: -2 };
    mocks.fetchPublicApi
      .mockResolvedValueOnce(Response.json({ incidents: [null, malformed] }))
      .mockResolvedValueOnce(Response.json({ incidents: [malformed], next_cursor: 42, mode: "bogus" }))
      .mockResolvedValueOnce(Response.json({ results: [malformed], total: -4, query: 7, terms: ["one", 2] }));

    const incidents = await fetchIncidents();
    const page = await fetchIncidentPage({});
    const search = await searchIncidentsApi({ q: "qa" });

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ id: "qa", lat: null, lng: null, confidence: 0 });
    expect(page).toMatchObject({ next_cursor: null, mode: "recent" });
    expect(page.incidents[0]).not.toHaveProperty("distance_km");
    expect(search).toMatchObject({ total: 0, query: "qa", terms: ["one"] });
  });

  it("rejects malformed REST envelopes instead of returning invalid shapes", async () => {
    mocks.fetchPublicApi.mockResolvedValueOnce(Response.json({ incidents: {} }));
    await expect(fetchIncidents()).rejects.toThrow("Malformed incidents response");
  });
});
