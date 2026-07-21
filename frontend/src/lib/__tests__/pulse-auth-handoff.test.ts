import { describe, expect, it } from "vitest";
import {
  attachPulseTokenFragment,
  pulseTokenFromUrl,
  urlWithoutPulseToken,
} from "@/lib/pulse-auth-handoff";

describe("cross-city auth handoff URLs", () => {
  it("places new credentials in the fragment rather than the query string", () => {
    const result = new URL(attachPulseTokenFragment("https://example.com/", "secret.token"));

    expect(result.search).toBe("");
    expect(result.hash).toBe("#__pulse_token=secret.token");
    expect(pulseTokenFromUrl(result)).toBe("secret.token");
  });

  it("continues to read legacy query handoffs", () => {
    expect(pulseTokenFromUrl(new URL("https://example.com/?__pulse_token=legacy")))
      .toBe("legacy");
  });

  it("scrubs the token while preserving unrelated URL state", () => {
    const url = new URL("https://example.com/map?city=philly#__pulse_token=secret&panel=alerts");

    expect(urlWithoutPulseToken(url)).toBe("/map?city=philly#panel=alerts");
    expect(url.toString()).not.toContain("secret");
  });
});
