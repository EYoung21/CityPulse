import { describe, expect, it } from "vitest";
import { safeSvgIdPart } from "@/lib/svg-id";

describe("safeSvgIdPart", () => {
  it("keeps ordinary IDs and removes raw-markup delimiters", () => {
    expect(safeSvgIdPart("incident_ABC-123")).toBe("incident_ABC-123");
    const escaped = safeSvgIdPart(`x\"/><script>alert(1)</script>`);
    expect(escaped).not.toMatch(/[\"'<>/()]/);
    expect(escaped).toContain("script_alert_1");
  });
});
