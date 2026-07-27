import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "@/lib/content-security-policy";

describe("content security policy", () => {
  it("enforces a nonce and removes unsafe production script execution", () => {
    const policy = contentSecurityPolicy({ nonce: "test-nonce" });

    expect(policy).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("report-uri /api/csp-report");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});
