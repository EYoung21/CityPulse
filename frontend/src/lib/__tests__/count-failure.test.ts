import { describe, expect, it } from "vitest";
import { classifyCountFailure } from "@/lib/count-failure";

describe("count endpoint failure classification", () => {
  it("treats an index build as temporary unavailability", () => {
    expect(classifyCountFailure("The index is currently building")).toEqual({
      status: 503,
      publicMessage: "count temporarily unavailable (index building)",
    });
  });

  it("treats missing application credentials as temporary unavailability", () => {
    expect(classifyCountFailure("Could not load the default credentials")).toEqual({
      status: 503,
      publicMessage: "count temporarily unavailable (credentials not configured)",
    });
  });

  it("keeps unknown server failures as internal errors", () => {
    expect(classifyCountFailure("permission denied")).toEqual({
      status: 500,
      publicMessage: "count failed",
    });
  });
});
