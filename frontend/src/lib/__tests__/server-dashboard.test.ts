import { describe, expect, it } from "vitest";
import {
  buildPublicActivitySummary,
  supportedDashboardCity,
} from "@/lib/server-dashboard";

describe("server dashboard fallbacks", () => {
  it("accepts only supported production cities", () => {
    expect(supportedDashboardCity(" SF ")).toEqual({
      slug: "sf",
      name: "San Francisco",
      publicSources: 2,
    });
    expect(supportedDashboardCity("not-a-city")).toBeNull();
  });

  it("builds a source-neutral summary without claiming scanner audio", () => {
    const summary = buildPublicActivitySummary(
      [
        {
          id: "one",
          severity_category: "fire_hazmat",
          location_text: "100 block Market St",
        },
        {
          id: "two",
          severity_category: "fire_hazmat",
          location_text: "200 block Pine St",
        },
        {
          id: "three",
          severity_category: "traffic_crash_no_injury",
          location_text: "Market St & 5th St",
        },
      ],
      "Philadelphia",
    );
    expect(summary).toContain("3 recent public incident reports");
    expect(summary).toContain("2 fire or hazardous-material responses");
    expect(summary).toContain("locations are intentionally approximate");
    expect(summary.toLowerCase()).not.toContain("scanner");
    expect(summary.toLowerCase()).not.toContain("audio");
  });

  it("handles an empty incident window", () => {
    expect(buildPublicActivitySummary([], "New York City")).toBe(
      "No recent public incident reports are available for New York City.",
    );
  });
});
