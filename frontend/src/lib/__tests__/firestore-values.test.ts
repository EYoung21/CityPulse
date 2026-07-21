import { describe, expect, it } from "vitest";
import {
  normalizeFiniteNumber,
  normalizeFirestoreCoordinate,
  normalizeFirestoreTimestamp,
  normalizeIncidentList,
  normalizeIncidentRecord,
  normalizeLocationConfidence,
} from "@/lib/firestore-values";

describe("Firestore value normalization", () => {
  it("treats malformed timestamps as stale instead of current", () => {
    expect(normalizeFirestoreTimestamp(undefined)).toBe("1970-01-01T00:00:00.000Z");
    expect(normalizeFirestoreTimestamp("not-a-date")).toBe("1970-01-01T00:00:00.000Z");
    expect(normalizeFirestoreTimestamp({ seconds: "bad" })).toBe("1970-01-01T00:00:00.000Z");
    expect(normalizeFirestoreTimestamp("2026-07-20T12:00:00")).toBe("2026-07-20T12:00:00.000Z");
  });

  it("rejects non-finite and out-of-range coordinates", () => {
    expect(normalizeFirestoreCoordinate("39.95", -90, 90)).toBe(39.95);
    expect(normalizeFirestoreCoordinate("", -90, 90)).toBeNull();
    expect(normalizeFirestoreCoordinate(Number.NaN, -90, 90)).toBeNull();
    expect(normalizeFirestoreCoordinate(91, -90, 90)).toBeNull();
  });

  it("bounds numeric values and defaults invalid confidence labels", () => {
    expect(normalizeFiniteNumber("0.8", 0, 0, 1)).toBe(0.8);
    expect(normalizeFiniteNumber(2, 0, 0, 1)).toBe(0);
    expect(normalizeLocationConfidence(undefined)).toBe("none");
    expect(normalizeLocationConfidence("direct")).toBe("direct");
    expect(normalizeLocationConfidence("made-up")).toBe("none");
  });

  it("normalizes incident structure and rejects unusable rows", () => {
    expect(normalizeIncidentRecord("", {})).toBeNull();
    expect(normalizeIncidentList([null, "bad", { id: "" }])).toEqual([]);

    const incident = normalizeIncidentRecord(" qa-1 ", {
      reported_at: "bad timestamp",
      lat: 39.95,
      lng: 999,
      confidence: 4,
      s_base: -1,
      word_timings: [
        { word: "valid", start: 0, end: 1 },
        { word: "backwards", start: 2, end: 1 },
      ],
      mentions: [null, { at: "2026-07-20T12:00:00Z", raw_text: "update" }],
    });

    expect(incident).toMatchObject({
      id: "qa-1",
      reported_at: "1970-01-01T00:00:00.000Z",
      lat: null,
      lng: null,
      confidence: 0,
      s_base: 0,
      word_timings: [{ word: "valid", start: 0, end: 1 }],
      mention_count: 1,
    });
  });
});
