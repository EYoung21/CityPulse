import { describe, expect, it } from "vitest";
import { trustedRequestOrigin } from "@/lib/request-origin";

describe("trustedRequestOrigin", () => {
  const fallback = "https://preview-citypulse.vercel.app";

  it("accepts registered Pulse and loopback hosts", () => {
    expect(trustedRequestOrigin("phlpulse.com", fallback)).toBe("https://phlpulse.com");
    expect(trustedRequestOrigin("www.sfopulse.com", fallback)).toBe("https://www.sfopulse.com");
    expect(trustedRequestOrigin("127.0.0.1:3100", fallback)).toBe("http://127.0.0.1:3100");
  });

  it("accepts only the exact configured deployment host", () => {
    expect(trustedRequestOrigin("preview-citypulse.vercel.app", fallback)).toBe(fallback);
    expect(trustedRequestOrigin("preview-citypulse.vercel.app.evil.test", fallback)).toBe(fallback);
  });

  it("rejects arbitrary, credentialed, path-bearing, and nonstandard production hosts", () => {
    expect(trustedRequestOrigin("evil.test", fallback)).toBe(fallback);
    expect(trustedRequestOrigin("phlpulse.com@evil.test", fallback)).toBe(fallback);
    expect(trustedRequestOrigin("phlpulse.com/path", fallback)).toBe(fallback);
    expect(trustedRequestOrigin("phlpulse.com:8443", fallback)).toBe(fallback);
  });
});
