import { describe, expect, it } from "vitest";
import { normalizeCityStatsPayload } from "@/hooks/useCityStats";

describe("city stats response validation", () => {
  it("accepts valid counters and rejects malformed payloads", () => {
    expect(normalizeCityStatsPayload({
      slug: "philly",
      city_name: "Philadelphia",
      scanner_feeds: 4,
      incidents_24h: -1,
      incidents_total: 100,
      generated_at: "2026-07-20T12:00:00Z",
    })).toMatchObject({ slug: "philly", incidents_24h: -1 });

    expect(normalizeCityStatsPayload({
      slug: "philly",
      city_name: "Philadelphia",
      scanner_feeds: -1,
      incidents_24h: 10,
      incidents_total: 100,
      generated_at: "not-a-date",
    })).toBeNull();
  });
});
