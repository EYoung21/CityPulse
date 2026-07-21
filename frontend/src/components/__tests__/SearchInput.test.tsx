import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const geocodePhilly = vi.hoisted(() => vi.fn());

vi.mock("@/lib/search", () => ({ geocodePhilly }));
vi.mock("@/lib/voice", () => ({
  isVoiceSearchSupported: () => false,
  startVoiceSearch: () => null,
}));
vi.mock("@/lib/recent-searches", () => ({
  clearRecent: vi.fn(),
  loadRecent: () => [],
  pushRecent: (entry: unknown) => [entry],
  removeRecent: () => [],
  subscribeRecent: () => () => {},
}));
vi.mock("@/hooks/useSavedDestinations", () => ({
  useSavedDestinations: () => ({
    destinations: [],
    canSave: false,
    addDestination: vi.fn(),
  }),
}));
vi.mock("@/components/QuickSavePlace", () => ({ default: () => null }));
vi.mock("@/components/CommutePredictionPill", () => ({ default: () => null }));
vi.mock("@/lib/commute-patterns", () => ({ predictNextCommute: () => null }));
vi.mock("@/lib/trip-history", () => ({ subscribeTripHistory: () => () => {} }));
vi.mock("@/lib/api", () => ({ searchIncidentsApi: vi.fn() }));
vi.mock("@/lib/pulse-cities", () => ({ getCurrentCity: () => ({ slug: "philadelphia" }) }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ isPro: false }) }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));

import SearchInput from "@/components/SearchInput";

describe("SearchInput", () => {
  beforeEach(() => {
    geocodePhilly.mockReset();
  });

  it("renders place suggestions as native keyboard-accessible buttons", async () => {
    geocodePhilly.mockResolvedValueOnce([
      {
        display_name: "Philadelphia City Hall, 1 South Penn Square, Philadelphia",
        name: "Philadelphia City Hall",
        address: "1 South Penn Square",
        lat: 39.9526,
        lng: -75.1636,
      },
    ]);
    const onFlyTo = vi.fn();
    const onPlaceSelected = vi.fn();

    render(
      <SearchInput
        onFlyTo={onFlyTo}
        onDirections={vi.fn()}
        onPlaceSelected={onPlaceSelected}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Search CityPulse" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Philadelphia City Hall" } });

    const suggestion = await screen.findByRole("button", { name: /Philadelphia City Hall/ });
    expect(suggestion.tagName).toBe("BUTTON");
    fireEvent.keyDown(suggestion, { key: "Enter" });

    expect(onFlyTo).toHaveBeenCalledWith(39.9526, -75.1636);
    expect(onPlaceSelected).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Philadelphia City Hall", lat: 39.9526, lng: -75.1636 }),
    );
  });
});
