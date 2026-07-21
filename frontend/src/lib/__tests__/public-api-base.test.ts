import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getExplicitPublicApiBase,
  getPublicApiBase,
  fetchIncidentWordTimings,
  incidentAudioSources,
} from "@/lib/public-api-base";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("public API and audio URL validation", () => {
  it("normalizes valid API bases", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.phlpulse.com/v1///");
    expect(getExplicitPublicApiBase()).toBe("https://api.phlpulse.com/v1");
  });

  it("rejects executable, credentialed, and query-bearing API bases", () => {
    for (const value of [
      "javascript:alert(1)",
      "https://user:pass@api.phlpulse.com",
      "https://api.phlpulse.com?redirect=evil",
    ]) {
      vi.stubEnv("NEXT_PUBLIC_API_URL", value);
      expect(getExplicitPublicApiBase()).toBe("");
      expect(getPublicApiBase()).toBe("");
    }
  });

  it("drops non-web and credential-bearing incident audio URLs", () => {
    expect(incidentAudioSources({ audio_url: "data:audio/wav;base64,AAAA" })).toEqual([]);
    expect(incidentAudioSources({ audio_url: "javascript:alert(1)" })).toEqual([]);
    expect(incidentAudioSources({ audio_url: "https://user:pass@example.com/a.wav" })).toEqual([]);
  });

  it("keeps normalized HTTPS audio URLs", () => {
    expect(incidentAudioSources({ audio_url: "https://cdn.example.com/a.wav" })).toEqual([
      "https://cdn.example.com/a.wav",
    ]);
  });

  it("filters malformed lazy word-timing rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      word_timings: [
        { word: "valid", start: 0, end: 1 },
        { word: "backwards", start: 2, end: 1 },
        { word: { bad: true }, start: 0, end: 1 },
      ],
    })));

    await expect(fetchIncidentWordTimings("qa")).resolves.toEqual([
      { word: "valid", start: 0, end: 1 },
    ]);
  });
});
