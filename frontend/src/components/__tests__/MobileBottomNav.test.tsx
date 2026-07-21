import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams("view=map"),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ isPro: false }),
}));

vi.mock("@/lib/alerts-inbox", () => ({
  subscribeAlerts: () => () => {},
  unreadCount: () => 0,
}));

import MobileBottomNav from "@/components/MobileBottomNav";

describe("MobileBottomNav", () => {
  beforeEach(() => {
    push.mockClear();
    sessionStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it("routes synthetic keyboard and assistive-technology clicks", () => {
    render(<MobileBottomNav />);

    fireEvent.click(screen.getByRole("button", { name: "Feed" }), { detail: 0 });

    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/feed");
  });

  it.each(["Enter", " "])("routes the %s keyboard key in embedded browsers", (key) => {
    render(<MobileBottomNav />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Feed" }), { key });

    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/feed");
  });

  it("does not route twice when a pointer click follows pointerup", () => {
    render(<MobileBottomNav />);
    const feed = screen.getByRole("button", { name: "Feed" });

    fireEvent.pointerUp(feed, { pointerType: "touch", button: 0 });
    fireEvent.click(feed, { detail: 1 });

    expect(push).toHaveBeenCalledOnce();
  });
});
