import { beforeEach, describe, expect, it } from "vitest";
import { clearAccountLocalData } from "@/lib/account-local-data";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

describe("account-local data deletion", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("clears CityPulse data but preserves unrelated origin storage", () => {
    window.localStorage.setItem("pp:trip-history-v1", "private trips");
    window.localStorage.setItem("pulse_ask_pulse_v1", "private chats");
    window.localStorage.setItem("phlpulse-theme", "dark");
    window.localStorage.setItem("unrelated-app", "keep");
    window.sessionStorage.setItem("cp:home-view", "feed");
    window.sessionStorage.setItem("unrelated-session", "keep");

    expect(clearAccountLocalData()).toBe(4);
    expect(window.localStorage.getItem("pp:trip-history-v1")).toBeNull();
    expect(window.localStorage.getItem("pulse_ask_pulse_v1")).toBeNull();
    expect(window.localStorage.getItem("phlpulse-theme")).toBeNull();
    expect(window.sessionStorage.getItem("cp:home-view")).toBeNull();
    expect(window.localStorage.getItem("unrelated-app")).toBe("keep");
    expect(window.sessionStorage.getItem("unrelated-session")).toBe("keep");
  });
});
