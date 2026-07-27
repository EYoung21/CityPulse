import { describe, expect, it } from "vitest";
import {
  PRIMARY_NAV_TABS,
  getPrimaryNavTab,
  hrefForPrimaryNavTab,
  nextPrimaryNavTab,
} from "@/lib/mobile-primary-tab-nav";

describe("mobile primary-tab navigation", () => {
  it("removes paused Ask Pulse from the swipe sequence", () => {
    expect(PRIMARY_NAV_TABS).toEqual(["map", "feed", "analytics"]);
    expect(nextPrimaryNavTab("feed", 1)).toBe("analytics");
    expect(nextPrimaryNavTab("analytics", 1)).toBeNull();
  });

  it("coerces stale Ask Pulse links back to the map", () => {
    expect(getPrimaryNavTab("/", "ask")).toBe("map");
    expect(hrefForPrimaryNavTab("ask")).toBe("/?view=map");
  });
});
