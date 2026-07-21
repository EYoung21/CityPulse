import { describe, expect, it } from "vitest";
import { normalizeBartArrivalsResponse } from "@/lib/bart";
import { normalizeSeptaArrivalsResponse } from "@/lib/septa";

describe("transit response validation", () => {
  it("drops malformed SEPTA arrivals and bounds fields", () => {
    expect(normalizeSeptaArrivalsResponse(null)).toBeNull();
    const normalized = normalizeSeptaArrivalsResponse({
      station: "S".repeat(120),
      fetched_label: "now",
      northbound: [
        null,
        { destination: "", depart_time: "soon" },
        { destination: "Center City", depart_time: "2026-07-20T12:00:00Z", status: 42 },
      ],
      southbound: "not-an-array",
    });
    expect(normalized?.station).toHaveLength(100);
    expect(normalized?.northbound).toEqual([
      expect.objectContaining({ destination: "Center City", status: "", line: null }),
    ]);
    expect(normalized?.southbound).toEqual([]);
  });

  it("drops malformed BART rows and rejects unsafe colors", () => {
    expect(normalizeBartArrivalsResponse([])).toBeNull();
    expect(normalizeBartArrivalsResponse({
      station_name: "Powell",
      fetched_label: "12:00 PM",
      arrivals: [
        { destination: "", minutes: "5", color: "#ff0000" },
        { destination: "Daly City", minutes: "5", color: "red; background:url(x)" },
      ],
    })?.arrivals).toEqual([
      { destination: "Daly City", minutes: "5", color: "#888888" },
    ]);
  });
});
