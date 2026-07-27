// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  getServerNeighborhoodBySlug,
  serverNeighborhoods,
} from "@/lib/server-neighborhoods";

describe("server neighborhood datasets", () => {
  it("loads the same public data used by client neighborhood profiles", async () => {
    const neighborhoods = await serverNeighborhoods("philly");
    const centerCity = await getServerNeighborhoodBySlug("philly", "center-city");

    expect(neighborhoods.length).toBeGreaterThan(5);
    expect(centerCity?.name).toBe("Center City");
  });

  it("fails closed for unsupported cities and unknown slugs", async () => {
    await expect(serverNeighborhoods("../../secrets")).resolves.toEqual([]);
    await expect(
      getServerNeighborhoodBySlug("philly", "not-a-neighborhood"),
    ).resolves.toBeNull();
  });
});
