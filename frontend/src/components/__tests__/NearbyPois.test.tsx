import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchNearbyPoisMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/overpass", () => ({
  fetchNearbyPois: fetchNearbyPoisMock,
  POI_CATEGORIES: [{ id: "food", label: "Food", emoji: "🍽️" }],
}));

import NearbyPois from "@/components/NearbyPois";

describe("NearbyPois", () => {
  beforeEach(() => {
    fetchNearbyPoisMock.mockReset();
  });

  it("offers keyboard-accessible selection and suppresses unsafe cached links", async () => {
    const onSelect = vi.fn();
    fetchNearbyPoisMock.mockResolvedValueOnce([{
      id: "node/1",
      name: "QA Cafe",
      category: "food",
      lat: 39.95,
      lng: -75.16,
      distance: 25,
      website: "javascript:alert(1)",
    }]);
    render(<NearbyPois lat={39.95} lng={-75.16} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Food" }));
    const selectButton = await screen.findByRole("button", { name: "Show QA Cafe on map" });
    expect(selectButton.tagName).toBe("BUTTON");
    fireEvent.click(selectButton);

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "QA Cafe" }));
    expect(screen.queryByRole("link", { name: "Open website for QA Cafe" })).toBeNull();
  });
});
