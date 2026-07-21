import { describe, expect, it } from "vitest";
import { buildIcs, type IcsEvent } from "@/lib/ics";

function eventWithTitle(title: string): IcsEvent {
  return {
    uid: "qa-citypulse",
    title,
    startUtc: new Date("2026-07-20T12:00:00Z"),
    endUtc: new Date("2026-07-20T12:30:00Z"),
  };
}

describe("buildIcs", () => {
  it("folds every physical line to at most 75 UTF-8 octets", () => {
    const title = "Safe route 🚲 through São Paulo — " + "neighborhood ".repeat(8);
    const ics = buildIcs(eventWithTitle(title));
    const encoder = new TextEncoder();

    for (const line of ics.split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it("does not split or lose non-ASCII characters while folding", () => {
    const title = "🚲安全な道".repeat(18);
    const ics = buildIcs(eventWithTitle(title));
    const summaryBlock = ics
      .split("\r\n")
      .reduce<string[]>((lines, line) => {
        if (line.startsWith("SUMMARY:")) return [line];
        if (lines.length > 0 && line.startsWith(" ")) return [...lines, line];
        return lines;
      }, [])
      .join("")
      .replace(/^SUMMARY:/, "")
      .replace(/ /g, "");

    expect(summaryBlock).toBe(title);
  });
});
