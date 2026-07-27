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

  it("enforces the free floor without upselling harmless request skew", () => {
    const now = Date.parse("2026-07-27T05:00:00Z");
    expect(effectiveSince("2026-07-24T04:59:59Z", false, now)).toEqual({
      since: "2026-07-24T05:00:00.000+00:00",
      clamped: false,
    });
    expect(effectiveSince("2026-07-24T04:54:59Z", false, now)).toEqual({
      since: "2026-07-24T05:00:00.000+00:00",
      clamped: true,
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
        location_text: "2917 Kings Point Rd Apt 4B",
        lat: 35.09736,
        lng: -85.219751,
        internal_source_payload: { victim: "must never escape" },
        ingestion_debug: "private",
        mentions: [
          {
            at: "2026-07-27T04:01:00Z",
            raw_text: "Public update",
            location_text: "987 Main St Unit 2",
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
      location_text: "2900 block Kings Point Rd",
      lat: 35.097,
      lng: -85.22,
      mentions: [
        {
          at: "2026-07-27T04:01:00Z",
          raw_text: "Public update",
          location_text: "900 block Main St",
        },
      ],
      word_timings: [{ word: "Public", start: 0, end: 0.5 }],
    });
  });
});
