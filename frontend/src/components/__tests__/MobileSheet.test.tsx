import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MobileSheet from "@/components/MobileSheet";

describe("MobileSheet", () => {
  it("keeps its close control inside the accessible drawer", () => {
    const onOpenChange = vi.fn();
    render(
      <MobileSheet open onOpenChange={onOpenChange}>
        <div>Sheet contents</div>
      </MobileSheet>,
    );

    const close = screen.getByRole("button", { name: "Close search and map tools" });
    expect(close.closest('[role="dialog"]')).not.toBeNull();

    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismisses fullscreen search without losing the click to input blur", async () => {
    const onOpenChange = vi.fn();
    render(
      <MobileSheet open onOpenChange={onOpenChange}>
        <input aria-label="Search test" />
      </MobileSheet>,
    );

    fireEvent.focus(screen.getByRole("textbox", { name: "Search test" }));
    const close = screen.getByRole("button", { name: "Close search" });
    fireEvent.pointerDown(close);
    fireEvent.click(close);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
