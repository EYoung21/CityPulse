import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import IncidentTypeFilterChips from "@/components/IncidentTypeFilterChips";
import type { Incident } from "@/lib/api";

const incidents = [
  { id: "violent", severity_category: "violent_no_weapon" },
  { id: "medical", severity_category: "medical_other" },
] as Incident[];

function Harness() {
  const [activeCats, setActiveCats] = useState<Set<string>>(() => new Set());
  return (
    <IncidentTypeFilterChips
      activeCats={activeCats}
      onActiveCatsChange={setActiveCats}
      incidentsForCounts={incidents}
    />
  );
}

describe("IncidentTypeFilterChips", () => {
  it("exposes readable counts and selected state", () => {
    render(<Harness />);

    expect(screen.getByRole("button", { name: "Show all incident types, 2 incidents" })
      .getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Violent, 1 incident" })
      .getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Medical, 1 incident" })
      .getAttribute("aria-pressed")).toBe("false");
  });
});
