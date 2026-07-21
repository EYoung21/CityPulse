import { beforeEach, describe, expect, it } from "vitest";
import { getAlerts } from "@/lib/alerts-inbox";
import { loadAvoidAreas } from "@/lib/avoid-areas";
import { loadPresets } from "@/lib/filter-presets";
import { loadReminders } from "@/lib/scheduled-reminders";
import { getTripHistory } from "@/lib/trip-history";
import { checkRateLimit } from "@/lib/feedback";
import { loadPushSnooze, setPushSnoozeUntil } from "@/lib/push-snooze";

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
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});

describe("collection-shaped browser storage validation", () => {
  it("filters malformed alert and reminder records", () => {
    localStorage.setItem("pp:alerts-inbox-v1", JSON.stringify([
      { id: "bad", incidentId: "bad", kind: "ahead", title: "Bad", body: "Bad", category: "x", lat: 999, lng: 0, ts: Date.now() },
      { id: "ok", incidentId: "inc", kind: "ahead", title: "Title", body: "Body", category: "medical", lat: 39.95, lng: -75.16, ts: Date.now(), read: true },
    ]));
    localStorage.setItem("pp:scheduled-reminders", JSON.stringify([
      { id: "bad", fireAt: Date.now(), departAt: Date.now(), leadMinutes: 10, destLabel: "Bad", destLat: 999, destLng: 0, mode: "walking" },
      { id: "ok", fireAt: Date.now(), departAt: Date.now() + 60_000, leadMinutes: 10, destLabel: "Good", destLat: 39.95, destLng: -75.16, mode: "walking" },
    ]));

    expect(getAlerts()).toEqual([expect.objectContaining({ id: "ok", read: true })]);
    expect(loadReminders()).toEqual([expect.objectContaining({ id: "ok", destLat: 39.95 })]);
  });

  it("normalizes trip history and route-adjacent collections", () => {
    const now = Date.now();
    localStorage.setItem("pp:trip-history-v1", JSON.stringify([
      { id: "bad", startedAt: now, endedAt: now - 1, traveledKm: 1, totalDistanceKm: 1, mode: "walk", nearbyIncidents: 0, wasSafeRoute: true, completed: true },
      {
        id: "ok", startedAt: now - 1_000, endedAt: now, traveledKm: 1, totalDistanceKm: 2,
        mode: "walk", nearbyIncidents: 1.9, wasSafeRoute: true, completed: false, rating: 9,
        geometry: [[39.95, -75.16], [999, 0]],
      },
    ]));
    localStorage.setItem("pp:avoid-areas", JSON.stringify([
      { id: "bad", lat: 999, lng: 0, radiusM: 100, createdAt: now },
      { id: "ok", lat: 39.95, lng: -75.16, radiusM: 9_999, createdAt: now },
    ]));
    localStorage.setItem("pp:filter-presets", JSON.stringify([
      { id: "ok", name: "  QA  ", cats: ["medical", 7, "medical"], timeFilterHours: 999, createdAt: now },
    ]));

    expect(getTripHistory()).toEqual([expect.objectContaining({
      id: "ok",
      nearbyIncidents: 1,
      rating: undefined,
      geometry: [[39.95, -75.16]],
    })]);
    expect(loadAvoidAreas()).toEqual([expect.objectContaining({ id: "ok", radiusM: 1_500 })]);
    expect(loadPresets()).toEqual([expect.objectContaining({
      id: "ok",
      name: "QA",
      cats: ["medical"],
      timeFilterHours: 1,
    })]);
  });

  it("does not let corrupt future timestamps block feedback or snooze indefinitely", () => {
    localStorage.setItem("pp:feedback-last-submit", String(Date.now() + 24 * 60 * 60_000));
    localStorage.setItem("pp:push-snooze-until", String(Date.now() + 365 * 24 * 60 * 60_000));
    expect(checkRateLimit()).toBeNull();
    expect(loadPushSnooze()).toEqual({ active: false, untilMs: 0 });

    const snooze = setPushSnoozeUntil(Date.now() + 365 * 24 * 60 * 60_000);
    expect(snooze.active).toBe(true);
    expect(snooze.untilMs).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60_000);
  });
});
