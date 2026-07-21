import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeIncidentCursor,
  encodeIncidentCursor,
  getDocsWithDeadline,
} from "@/lib/firestore";

describe("Firestore read guards", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects a stalled one-shot read at its deadline", async () => {
    vi.useFakeTimers();
    const pending = getDocsWithDeadline(new Promise<never>(() => {}), undefined, 1000);
    const rejection = expect(pending).rejects.toThrow("Firestore request timed out");

    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
  });

  it("preserves document IDs in equal-timestamp cursors", () => {
    const timestamp = "2026-07-20T20:00:00.000Z";
    const first = encodeIncidentCursor(timestamp, "incident-b");
    const second = encodeIncidentCursor(timestamp, "incident-a");

    expect(first).not.toBe(second);
    expect(decodeIncidentCursor(first)).toEqual({
      reportedAt: timestamp,
      documentId: "incident-b",
    });
  });

  it("accepts legacy timestamp-only cursors", () => {
    expect(decodeIncidentCursor("2026-07-20T20:00:00.000Z")).toEqual({
      reportedAt: "2026-07-20T20:00:00.000Z",
      documentId: "",
    });
  });
});
