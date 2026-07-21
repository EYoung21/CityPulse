import { describe, expect, it } from "vitest";
import { normalizeKeywordWatch, normalizePulseChatResponse } from "@/lib/api";

describe("API response validation", () => {
  it("rejects malformed keyword watches and clamps scalar fields", () => {
    expect(normalizeKeywordWatch(null)).toBeNull();
    expect(normalizeKeywordWatch({ id: "", keyword: "x", city: "philly" })).toBeNull();

    expect(normalizeKeywordWatch({
      id: "watch-1",
      keyword: "  shots fired  ",
      city: "philly",
      severityFloor: 99,
      active: "yes",
      createdAtMs: Number.POSITIVE_INFINITY,
      lastFiredMs: -10,
      lastIncidentId: 42,
    })).toEqual({
      id: "watch-1",
      keyword: "shots fired",
      city: "philly",
      severityFloor: 0,
      active: false,
      createdAtMs: 0,
      lastFiredMs: 0,
      lastIncidentId: null,
    });
  });

  it("normalizes Ask Pulse citations, incidents, metadata, and reply length", () => {
    expect(() => normalizePulseChatResponse({ citations: [] })).toThrow("Malformed Ask Pulse response");

    const normalized = normalizePulseChatResponse({
      reply: "x".repeat(100_010),
      citations: [
        null,
        { id: "incident-1", reported_at: 42, category: "medical_priority" },
      ],
      cited_incidents: [null, "bad"],
      meta: {
        city: "philly",
        incidents_in_context: -3,
        incidents_fetched: 12.9,
        truncated: "yes",
        tool_rounds: 2,
      },
    });

    expect(normalized.reply).toHaveLength(100_000);
    expect(normalized.citations).toEqual([
      { id: "incident-1", reported_at: null, category: "medical_priority" },
    ]);
    expect(normalized.cited_incidents).toEqual([]);
    expect(normalized.meta).toMatchObject({
      city: "philly",
      incidents_in_context: 0,
      incidents_fetched: 12,
      truncated: false,
      tool_rounds: 2,
    });
  });
});
