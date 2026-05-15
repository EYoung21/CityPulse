"use client";

import { useMemo } from "react";
import {
  INCIDENT_CATEGORY_GROUPS,
  toggleCategoryGroupSelection,
} from "@/lib/incident-category-groups";
import type { Incident } from "@/lib/api";

interface Props {
  activeCats: Set<string>;
  onActiveCatsChange: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** When set, each pill shows a count for that group in this slice. */
  incidentsForCounts?: Incident[];
  /** "panel" matches analytics / feed chrome; "mapLike" uses map pill tokens. */
  variant?: "panel" | "mapLike";
  className?: string;
}

export default function IncidentTypeFilterChips({
  activeCats,
  onActiveCatsChange,
  incidentsForCounts,
  variant = "panel",
  className = "",
}: Props) {
  const counts = useMemo(() => {
    if (!incidentsForCounts) return null;
    return INCIDENT_CATEGORY_GROUPS.map(
      (g) => incidentsForCounts.filter((i) => g.cats.includes(i.severity_category)).length
    );
  }, [incidentsForCounts]);

  const isMap = variant === "mapLike";

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <span
        className="text-[10px] font-bold uppercase tracking-wider shrink-0 mr-0.5"
        style={{ color: "var(--panel-text-muted)" }}
      >
        Type
      </span>
      <button
        type="button"
        onClick={() => onActiveCatsChange(new Set())}
        className="px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider transition-colors shrink-0"
        style={
          activeCats.size === 0
            ? isMap
              ? { background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.35)", color: "#3b82f6" }
              : { background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.35)", color: "#3b82f6" }
            : isMap
              ? { background: "var(--pill-bg)", border: "1px solid var(--pill-border)", color: "var(--pill-text)" }
              : {
                  background: "var(--panel-input-bg)",
                  border: "1px solid var(--panel-border)",
                  color: "var(--panel-text-secondary)",
                }
        }
      >
        All
      </button>
      {INCIDENT_CATEGORY_GROUPS.map((pill, idx) => {
        const isActive = pill.cats.some((c) => activeCats.has(c));
        const n = counts?.[idx];
        return (
          <button
            key={pill.label}
            type="button"
            onClick={() =>
              onActiveCatsChange((prev) => toggleCategoryGroupSelection(pill.cats, prev))
            }
            className="px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors shrink-0"
            style={
              isActive
                ? {
                    background: `${pill.color}22`,
                    border: `1px solid ${pill.color}55`,
                    color: pill.color,
                  }
                : isMap
                  ? { background: "var(--pill-bg)", border: "1px solid var(--pill-border)", color: "var(--pill-text)" }
                  : {
                      background: "var(--panel-input-bg)",
                      border: "1px solid var(--panel-border)",
                      color: "var(--panel-text-secondary)",
                    }
            }
          >
            <span className="uppercase tracking-wider">{pill.label}</span>
            {n != null && n > 0 && (
              <span className="ml-1 font-mono text-[10px] opacity-80">{n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
