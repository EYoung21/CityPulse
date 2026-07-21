import { beforeEach, describe, expect, it, vi } from "vitest";

describe("transit directions upstream validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubEnv("TRANSIT_OTP_URL", "https://otp.example");
  });

  it("rejects malformed itinerary coordinates instead of returning NaN geometry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          plan: {
            itineraries: [{
              duration: 600,
              legs: [{
                mode: "RAIL",
                from: { name: "A", lat: 999, lon: -75.1 },
                to: { name: "B", lat: 39.9, lon: -75.2 },
              }],
            }],
          },
        }), { status: 200 }),
      ),
    );
    const { POST } = await import("../route");
    const response = await POST(new Request("http://localhost/api/transit-directions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: [39.95, -75.16],
        destination: [39.96, -75.17],
        mode: "RAIL",
      }),
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("invalid") });
  });
});
