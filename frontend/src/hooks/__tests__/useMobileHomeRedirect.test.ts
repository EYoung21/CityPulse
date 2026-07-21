import { beforeEach, describe, expect, it } from "vitest";
import { decideHomeRedirect } from "@/hooks/useMobileHomeRedirect";

describe("mobile home redirect decisions", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => Array.from(values.keys())[index] ?? null,
      removeItem: (key) => { values.delete(key); },
      setItem: (key, value) => { values.set(key, String(value)); },
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("does not let a sticky feed preference override home-only tabs", () => {
    window.localStorage.setItem("cp:home-view", "feed");

    window.history.replaceState({}, "", "/?view=ask");
    expect(decideHomeRedirect()).toBe("stay");

    window.history.replaceState({}, "", "/?view=analytics");
    expect(decideHomeRedirect()).toBe("stay");
  });

  it("honors explicit map and feed requests on mobile", () => {
    window.history.replaceState({}, "", "/?view=map");
    expect(decideHomeRedirect(true)).toBe("stay");
    expect(window.localStorage.getItem("cp:home-view")).toBe("map");

    window.history.replaceState({}, "", "/?view=feed");
    expect(decideHomeRedirect(true)).toBe("redirect");
    expect(window.localStorage.getItem("cp:home-view")).toBe("feed");
  });

  it("keeps the embedded feed tab on desktop, including after reload", () => {
    window.history.replaceState({}, "", "/?view=feed");
    expect(decideHomeRedirect(false)).toBe("stay");
    expect(window.localStorage.getItem("cp:home-view")).toBe("feed");

    window.history.replaceState({}, "", "/");
    expect(decideHomeRedirect(false)).toBe("stay");
  });

  it("uses a sticky feed preference only for the mobile home route", () => {
    window.localStorage.setItem("cp:home-view", "feed");
    expect(decideHomeRedirect(true)).toBe("redirect");
    expect(decideHomeRedirect(false)).toBe("stay");
  });

  it("keeps incident and coordinate deep links on the map", () => {
    window.localStorage.setItem("cp:home-view", "feed");

    window.history.replaceState({}, "", "/?incident=abc123");
    expect(decideHomeRedirect()).toBe("stay");

    window.history.replaceState({}, "", "/?lat=39.95&lng=-75.16");
    expect(decideHomeRedirect()).toBe("stay");
  });
});
