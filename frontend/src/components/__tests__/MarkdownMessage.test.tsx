import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "@/components/MarkdownMessage";

describe("MarkdownMessage", () => {
  it("does not load model-authored remote images", () => {
    const { container } = render(
      <MarkdownMessage content="![map preview](https://tracker.example/pixel.png)" />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("[Image: map preview]")).toBeTruthy();
  });

  it("keeps links isolated from the opener", () => {
    render(<MarkdownMessage content="[Source](https://example.com/report)" />);

    const link = screen.getByRole("link", { name: "Source" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders model-authored non-web links as inert text", () => {
    const { container } = render(
      <MarkdownMessage content="[Run this](javascript:alert(document.domain))" />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("Run this")).toBeTruthy();
  });
});
