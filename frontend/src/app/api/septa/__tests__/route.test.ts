import { beforeEach, describe, expect, it, vi } from "vitest";

describe("SEPTA proxy health reporting", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("does not label malformed next-to-arrive JSON as healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } })
      )
    );
    const { GET } = await import("../route");
    const response = await GET(
      new Request("http://localhost/api/septa?op=next-to-arrive&from=Swarthmore&to=Suburban%20Station&n=3")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.trips).toEqual([]);
    expect(body.meta.upstream_ok).toBe(false);
  });

  it("drops malformed arrivals while preserving valid rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        "Swarthmore Departures: now": [{
          Northbound: [null, {
            direction: "N",
            origin: "Media",
            destination: "Suburban Station",
            sched_time: "2026-07-20T10:00:00Z",
            depart_time: "2026-07-20T10:02:00Z",
            status: 7,
            line: "Media/Wawa",
            train_id: "123",
            track: "2",
            service_type: "Local",
          }],
        }],
      }))),
    );
    const { GET } = await import("../route");
    const response = await GET(
      new Request("http://localhost/api/septa?op=arrivals&station=Swarthmore"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.northbound).toEqual([
      expect.objectContaining({ destination: "Suburban Station", status: "" }),
    ]);
  });
});
