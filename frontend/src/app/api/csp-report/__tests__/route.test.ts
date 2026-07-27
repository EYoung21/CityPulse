import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CSP report endpoint", () => {
  it("logs a bounded report without query strings or fragments", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await POST(
      new Request("https://www.phlpulse.com/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/csp-report" },
        body: JSON.stringify({
          "csp-report": {
            "document-uri": "https://www.phlpulse.com/share/trip?t=secret#fragment",
            "blocked-uri": "https://cdn.example/script.js?credential=secret",
            "effective-directive": "script-src-elem",
            "line-number": 12,
          },
        }),
      }),
    );

    expect(response.status).toBe(204);
    expect(warning).toHaveBeenCalledOnce();
    const logged = String(warning.mock.calls[0]?.[1]);
    expect(logged).toContain("https://www.phlpulse.com/share/trip");
    expect(logged).toContain("https://cdn.example/script.js");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("fragment");
  });

  it("rejects malformed and oversized reports", async () => {
    const malformed = await POST(
      new Request("https://www.phlpulse.com/api/csp-report", {
        method: "POST",
        body: "not-json",
      }),
    );
    expect(malformed.status).toBe(400);

    const oversized = await POST(
      new Request("https://www.phlpulse.com/api/csp-report", {
        method: "POST",
        headers: { "content-length": "9000" },
        body: "{}",
      }),
    );
    expect(oversized.status).toBe(413);
  });
});
