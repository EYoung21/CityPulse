import { describe, expect, it } from "vitest";
import {
  CURSOR_SEPARATOR,
  canonicalIso,
  effectiveSince,
  enrichIncident,
  haversineKm,
  parseCursor,
  publicIncidentData,
} from "@/lib/server-incidents";

describe("server incident fallback", () => {
  it("clamps free history but preserves Pro history", () => {
    const now = Date.parse("2026-07-27T05:00:00Z");
    const requested = "2026-07-01T00:00:00Z";
    const free = effectiveSince(requested, false, now);
    expect(free.clamped).toBe(true);
    expect(free.since).toBe("2026-07-24T05:00:00.000+00:00");
    expect(effectiveSince(requested, true, now)).toEqual({
      since: "2026-07-01T00:00:00.000+00:00",
      clamped: false,
    });
  });

  it("validates compound cursors", () => {
    expect(parseCursor(`2026-07-27T04:00:00Z${CURSOR_SEPARATOR}abc_123`)).toEqual({
      timestamp: "2026-07-27T04:00:00.000+00:00",
      id: "abc_123",
    });
    expect(parseCursor(`2026-07-27T04:00:00Z${CURSOR_SEPARATOR}bad/id`)).toBeNull();
    expect(canonicalIso("not-a-date")).toBeNull();
  });

  it("computes finite decayed weights and distance", () => {
    const row = enrichIncident(
      "incident-1",
      {
        reported_at: "2026-07-27T04:00:00+00:00",
        s_base: 1,
        confidence: 1,
      },
      Date.parse("2026-07-27T05:00:00Z"),
    );
    expect(row.w_eff).toBeCloseTo(Math.exp(-1 / 12), 4);
    expect(haversineKm(39.9526, -75.1652, 39.9526, -75.1652)).toBe(0);
  });

  it("projects Firestore documents onto an explicit public contract", () => {
    expect(
      publicIncidentData({
        reported_at: "2026-07-27T04:00:00Z",
        raw_text: "Public description",
        internal_source_payload: { victim: "must never escape" },
        ingestion_debug: "private",
        mentions: [
          {
            at: "2026-07-27T04:01:00Z",
            raw_text: "Public update",
            private_operator_note: "must never escape",
          },
        ],
        word_timings: [
          {
            word: "Public",
            start: 0,
            end: 0.5,
            speaker_identity: "must never escape",
          },
        ],
      }),
    ).toEqual({
      reported_at: "2026-07-27T04:00:00Z",
      raw_text: "Public description",
      mentions: [
        {
          at: "2026-07-27T04:01:00Z",
          raw_text: "Public update",
        },
      ],
      word_timings: [{ word: "Public", start: 0, end: 0.5 }],
    });
  });
});
