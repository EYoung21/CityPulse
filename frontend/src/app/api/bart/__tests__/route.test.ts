import { beforeEach, describe, expect, it, vi } from "vitest";

describe("BART proxy health reporting", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("does not label malformed upstream JSON as healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } })
      )
    );
    const { GET } = await import("../route");
    const response = await GET(
      new Request("http://localhost/api/bart?op=etd&station=POWL")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.arrivals).toEqual([]);
    expect(body.meta.upstream_ok).toBe(false);
  });

  it("drops malformed arrival rows and constrains upstream colors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        root: {
          time: "10:00 PM",
          station: [{
            name: "Powell",
            etd: [null, {
              destination: "Daly City",
              estimate: [null, { minutes: "5", hexcolor: "url(javascript:bad)" }],
            }],
          }],
        },
      }))),
    );
    const { GET } = await import("../route");
    const response = await GET(
      new Request("http://localhost/api/bart?op=etd&station=POWL"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.arrivals).toEqual([
      expect.objectContaining({ destination: "Daly City", minutes: "5", color: "#888888" }),
    ]);
  });
});
