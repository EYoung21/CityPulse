import { describe, expect, it } from "vitest";
import { filterIncidentsSince } from "@/hooks/useFeedIncidents";
import type { Incident } from "@/lib/api";

const rows = [
  { id: "old", reported_at: "2026-07-19T01:00:00.000Z" },
  { id: "boundary", reported_at: "2026-07-19T02:00:00.000Z" },
  { id: "new", reported_at: "2026-07-19T03:00:00.000Z" },
] as Incident[];

describe("filterIncidentsSince", () => {
  it("removes cached incidents older than the selected window", () => {
    expect(filterIncidentsSince(rows, "2026-07-19T02:00:00.000Z").map((row) => row.id))
      .toEqual(["boundary", "new"]);
  });

  it("preserves rows when no valid boundary is supplied", () => {
    expect(filterIncidentsSince(rows)).toBe(rows);
    expect(filterIncidentsSince(rows, "not-a-date")).toBe(rows);
  });
});
