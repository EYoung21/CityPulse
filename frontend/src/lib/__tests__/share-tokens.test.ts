import { describe, expect, it } from "vitest";
import {
  buildLiveShareUrl,
  liveShareMovedEnough,
} from "@/lib/live-share";
import {
  isLiveShareId,
  parseLiveTripDoc,
} from "@/lib/live-share-validation";
import {
  buildListShareUrl,
  decodeListToken,
  encodeListToken,
} from "@/lib/share-list";
import {
  buildTripShareUrl,
  decodeTripToken,
  encodeTripToken,
} from "@/lib/share-trip";
import {
  shareValueFromUrl,
  urlWithCanonicalShareFragment,
} from "@/lib/share-fragment";

function tokenFor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("shared-link validation", () => {
  it("keeps list, trip, and live bearer values out of query strings", () => {
    const listUrl = new URL(buildListShareUrl({
      listName: "Favorites",
      items: [{ name: "Home", lat: 39.95, lng: -75.16 }],
    }, "https://example.com"));
    const tripUrl = new URL(buildTripShareUrl({
      destination: [39.9526, -75.1652],
      mode: "foot-walking",
      etaEpochMs: Date.now() + 60_000,
      sentAtEpochMs: Date.now(),
      geometry: [[39.95, -75.17], [39.9526, -75.1652]],
    }, "https://example.com"));
    const liveUrl = new URL(buildLiveShareUrl(
      "0ABCDEFGHJKM",
      "https://example.com"
    ));

    expect(listUrl.search).toBe("");
    expect(listUrl.hash).toMatch(/^#t=/);
    expect(tripUrl.search).toBe("");
    expect(tripUrl.hash).toMatch(/^#t=/);
    expect(liveUrl.search).toBe("");
    expect(liveUrl.hash).toBe("#id=0ABCDEFGHJKM");
  });

  it("reads fragments and canonicalizes legacy query-string links", () => {
    const fragment = new URL("https://example.com/share/trip#t=private-token");
    expect(shareValueFromUrl(fragment, "t", 100)).toEqual({
      value: "private-token",
      source: "fragment",
    });

    const legacy = new URL("https://example.com/share/trip?utm=x&t=old-token");
    expect(shareValueFromUrl(legacy, "t", 100)).toEqual({
      value: "old-token",
      source: "legacy-query",
    });
    expect(urlWithCanonicalShareFragment(legacy, "t", "old-token"))
      .toBe("/share/trip?utm=x#t=old-token");
  });

  it("rejects duplicate or oversized share bearer parameters", () => {
    expect(shareValueFromUrl(
      new URL("https://example.com/share/trip#t=one&t=two"),
      "t",
      100
    )).toBeNull();
    expect(shareValueFromUrl(
      new URL("https://example.com/share/trip#t=toolong"),
      "t",
      3
    )).toBeNull();
  });

  it("round-trips Unicode trip sender names", () => {
    const token = encodeTripToken({
      name: "Zoë 🚲",
      destination: [39.9526, -75.1652],
      mode: "cycling-regular",
      etaEpochMs: Date.now() + 60_000,
      sentAtEpochMs: Date.now(),
      geometry: [[39.95, -75.17], [39.9526, -75.1652]],
    });
    expect(decodeTripToken(token)?.name).toBe("Zoë 🚲");
  });

  it("rejects unsupported trip modes and coordinates", () => {
    expect(decodeTripToken(tokenFor({
      v: 1,
      d: [120, -75],
      m: "teleport",
      eta: Date.now(),
      sentAt: Date.now(),
      g: "",
    }))).toBeNull();
  });

  it("drops out-of-range list items and invalid colors", () => {
    const decoded = decodeListToken(tokenFor({
      v: 1,
      ln: "Places",
      c: "not-a-color",
      i: [[39.95, -75.16, "Valid"], [91, -75, "Invalid"]],
    }));
    expect(decoded?.color).toBeUndefined();
    expect(decoded?.items).toEqual([{ name: "Valid", lat: 39.95, lng: -75.16 }]);
  });

  it("caps decoded list snapshots and rejects oversized tokens", () => {
    const rows = Array.from({ length: 150 }, (_, i) => [39.95, -75.16, `Place ${i}`]);
    expect(decodeListToken(tokenFor({ v: 1, ln: "Places", i: rows }))?.items).toHaveLength(100);
    expect(decodeListToken("a".repeat(32_001))).toBeNull();
  });

  it("filters invalid items while encoding lists", () => {
    const decoded = decodeListToken(encodeListToken({
      listName: "Places",
      items: [
        { name: "Valid", lat: 39.95, lng: -75.16 },
        { name: "Invalid", lat: 100, lng: -75.16 },
      ],
    }));
    expect(decoded?.items).toHaveLength(1);
  });

  it("detects movement against the previous live-share position", () => {
    expect(liveShareMovedEnough(
      { lat: 39.95, lng: -75.16 },
      { lat: 39.9501, lng: -75.16 }
    )).toBe(true);
    expect(liveShareMovedEnough(
      { lat: 39.95, lng: -75.16 },
      { lat: 39.950001, lng: -75.16 }
    )).toBe(false);
  });

  it("validates live share IDs and public snapshot data", () => {
    expect(isLiveShareId("0ABCDEFGHJKM")).toBe(true);
    expect(isLiveShareId("bad/id")).toBe(false);

    const valid = {
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      ownerUid: "user-1",
      ownerName: null,
      dest: { lat: 39.96, lng: -75.17, name: "Home" },
      position: { lat: 39.95, lng: -75.16, heading: null },
      etaAt: Date.now() + 30_000,
      progressPct: 0.5,
      mode: "foot-walking",
      ended: false,
    };
    expect(parseLiveTripDoc(valid)?.dest.name).toBe("Home");
    expect(parseLiveTripDoc({ ...valid, position: { ...valid.position, lat: 999 } })).toBeNull();
    expect(parseLiveTripDoc({ ...valid, expiresAt: "tomorrow" })).toBeNull();
  });
});
