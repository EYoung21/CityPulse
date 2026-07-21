import { describe, expect, it } from "vitest";
import { normalizeHttpUrl } from "@/lib/safe-url";

describe("normalizeHttpUrl", () => {
  it("normalizes web URLs and rejects executable or credentialed URLs", () => {
    expect(normalizeHttpUrl("example.com/path")).toBe("https://example.com/path");
    expect(normalizeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeHttpUrl("data:text/html,hello")).toBeNull();
    expect(normalizeHttpUrl("https://user:pass@example.com")).toBeNull();
  });
});
