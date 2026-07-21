import { describe, expect, it } from "vitest";
import type { Incident } from "@/lib/api";
import { incidentHeadline, incidentLocationLabel } from "@/lib/incident-display";
import { sanitizeScannerTranscriptForDisplay, hasScannerTranscriptArtifacts } from "@/lib/sanitize-scanner-transcript";
import { getSeverity, severityBucket, heatmapWeight } from "@/lib/severity";
import { coordKey, formatEtaShort, normalizeModeEtaResponse } from "@/hooks/useModeETAs";

function inc(overrides: Partial<Incident>): Incident {
  return {
    id: "inc",
    reported_at: "2026-01-01T00:00:00.000Z",
    raw_text: "",
    severity_category: "traffic_crash_injury",
    s_base: 0.8,
    confidence: 0.9,
    inhibitor_status: "passed",
    location_text: null,
    description: null,
    ...overrides,
  } as Incident;
}

describe("severity helpers", () => {
  it("returns known severity labels and fallback labels", () => {
    expect(getSeverity("traffic_crash_injury").label).toBe("Crash (Injuries)");
    expect(getSeverity("mystery_call").label).toBe("mystery call");
  });

  it("buckets severity categories and clamps heatmap weight", () => {
    expect(severityBucket("shots_heard")).toBe("violent");
    expect(severityBucket("traffic_hazard")).toBe("traffic");
    expect(severityBucket(undefined)).toBe("other");
    expect(heatmapWeight("violent_weapon", 0.9)).toBe(1);
    expect(heatmapWeight("user_other", 0.01)).toBe(0.18);
  });
});

describe("scanner transcript display cleanup", () => {
  it("collapses repeated comma-delimited scanner loops", () => {
    const text = "Engine 1, Engine 1, Engine 1, Engine 1, Engine 1, respond now with repeated scanner audio artifact";
    expect(sanitizeScannerTranscriptForDisplay(text)).toContain("(5× similar phrase from scanner)");
    expect(hasScannerTranscriptArtifacts(text)).toBe(true);
  });

  it("collapses apology spam and handles empty input", () => {
    expect(sanitizeScannerTranscriptForDisplay(null)).toBe("");
    expect(
      sanitizeScannerTranscriptForDisplay("I'm sorry I'm sorry I'm sorry I'm sorry I'm sorry I'm sorry units clear")
    ).toContain("I'm sorry");
  });

  it("does not flag normal prose as scanner artifacts", () => {
    expect(hasScannerTranscriptArtifacts("Medic requested for a fall injury near Broad and Pine.")).toBe(false);
  });
});

describe("incident display labels", () => {
  it("prefers description, then truncated raw text, then severity label", () => {
    expect(incidentHeadline(inc({ description: "Crash with injuries" }))).toBe("Crash with injuries");
    const longRaw = "x".repeat(160);
    expect(incidentHeadline(inc({ raw_text: longRaw }))).toHaveLength(138);
    expect(incidentHeadline(inc({ raw_text: longRaw }))).toMatch(/…$/);
    expect(incidentHeadline(inc({ severity_category: "fire_hazmat" }))).toBe("Fire / Hazmat");
  });

  it("uses a safe location fallback", () => {
    expect(incidentLocationLabel(inc({ location_text: "Broad and Pine" }))).toBe("Broad and Pine");
    expect(incidentLocationLabel(inc({ location_text: "   " }))).toBe("Unknown location");
  });
});

describe("ETA formatting helpers", () => {
  it("formats compact ETAs", () => {
    expect(formatEtaShort(0)).toBe("<1 min");
    expect(formatEtaShort(12.4)).toBe("12 min");
    expect(formatEtaShort(60)).toBe("1 h");
    expect(formatEtaShort(91)).toBe("1 h 31");
  });

  it("rounds coordinate keys to three decimals", () => {
    expect(coordKey(null)).toBe("");
    expect(coordKey({ lat: 39.95049, lng: -75.16049 })).toBe("39.950,-75.160");
    expect(coordKey({ lat: 39.95051, lng: -75.16051 })).toBe("39.951,-75.161");
  });

  it("rejects malformed mode ETA responses", () => {
    expect(normalizeModeEtaResponse({ durationMin: Number.NaN, distanceKm: 1 })).toBeNull();
    expect(normalizeModeEtaResponse({ durationMin: -1 })).toBeNull();
    expect(normalizeModeEtaResponse({ durationMin: 12, distanceKm: Number.POSITIVE_INFINITY }))
      .toEqual({ durationMin: 12, distanceKm: undefined });
  });
});
