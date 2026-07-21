import { describe, expect, it } from "vitest";
import {
  normalizeIncidentShareParams,
  singleSearchParam,
  strictSingleSearchParam,
} from "@/lib/share-params";

describe("share query normalization", () => {
  it("bounds repeated text params and rejects invalid navigation state", () => {
    expect(normalizeIncidentShareParams({
      incident: "bad/path",
      lat: "999",
      lng: "-75",
      zoom: "Infinity",
      t: [" first ", "second"],
      loc: "x".repeat(300),
    })).toEqual({
      incident: undefined,
      zoom: undefined,
      t: "first",
      c: undefined,
      loc: "x".repeat(240),
      time: undefined,
    });
  });

  it("keeps a valid coordinate pair and bounded scalar token", () => {
    expect(normalizeIncidentShareParams({ lat: "39.95", lng: "-75.16", zoom: "13" }))
      .toMatchObject({ lat: "39.95", lng: "-75.16", zoom: "13" });
    expect(singleSearchParam([" token ", "ignored"], 20)).toBe("token");
    expect(strictSingleSearchParam("x".repeat(21), 20)).toBeUndefined();
  });
});
