import { beforeEach, describe, expect, it, vi } from "vitest";

describe("create-checkout authentication", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("rejects a signed-out request before initializing Stripe", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { POST } = await import("../route");

    const response = await POST(new Request("http://localhost/api/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "monthly" }),
    }) as never);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
