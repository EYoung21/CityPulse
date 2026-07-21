import { describe, expect, it } from "vitest";
import { normalizeAdminEvent } from "@/hooks/useAdminStream";

describe("admin stream response validation", () => {
  it("rejects malformed events and bounds routing fields", () => {
    expect(normalizeAdminEvent(null)).toBeNull();
    expect(normalizeAdminEvent({ type: "" })).toBeNull();
    expect(normalizeAdminEvent({
      type: " transcript_received ",
      correlation: "x".repeat(600),
      feed_id: "y".repeat(300),
      ts: Number.POSITIVE_INFINITY,
      transcript: "kept for the admin UI",
    })).toMatchObject({
      type: "transcript_received",
      ts: 0,
      transcript: "kept for the admin UI",
    });
    expect(normalizeAdminEvent({
      type: "ok",
      correlation: "x".repeat(600),
      feed_id: "y".repeat(300),
    })?.correlation).toHaveLength(500);
    expect(normalizeAdminEvent({
      type: "ok",
      correlation: "x",
      feed_id: "y".repeat(300),
    })?.feed_id).toHaveLength(200);
  });
});
