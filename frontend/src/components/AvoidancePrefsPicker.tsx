"use client";

import { useState } from "react";
import { ChevronDown, Clock, Shield, ShieldAlert, ShieldCheck, SlidersHorizontal } from "lucide-react";
import {
  AVOIDANCE_CATEGORIES,
  LEAF_LABELS,
  SEVERITY_FLOORS,
  type AvoidancePrefs,
  type SeverityFloor,
} from "@/lib/routing";

interface Props {
  prefs: AvoidancePrefs;
  onChange: (next: AvoidancePrefs) => void;
}

const FLOOR_PILLS: { id: SeverityFloor; label: string }[] = [
  { id: "any", label: "Any" },
  { id: "low", label: "Low+" },
  { id: "medium", label: "Medium+" },
  { id: "high", label: "High+" },
];

/** Routing-only time horizon. `null` = follow the global map window (the
 *  current default); explicit values further constrain it. */
const AGE_PILLS: { id: number | null; label: string }[] = [
  { id: null, label: "Map window" },
  { id: 0.25, label: "15m" },
  { id: 1, label: "1h" },
  { id: 6, label: "6h" },
  { id: 24, label: "24h" },
];

const CONTROL_ROW_CLASS =
  "px-4 py-2.5 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2";
const CONTROL_LABEL_CLASS = "flex items-center gap-2 shrink-0";
const CONTROL_GROUP_CLASS = "min-w-0 flex flex-wrap items-center gap-1.5";

/** Safety-first avoidance picker. The five bucket toggles stay in the
 *  primary loop; granular leaves, severity floor, and routing time
 *  horizon sit one tap deeper under Advanced. */
export default function AvoidancePrefsPicker({ prefs, onChange }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const toggleLeaf = (leaf: string) => {
    const next = new Set(prefs.leaves);
    if (next.has(leaf)) next.delete(leaf);
    else next.add(leaf);
    onChange({ ...prefs, leaves: next });
  };

  const setBucket = (cats: readonly string[], on: boolean) => {
    const next = new Set(prefs.leaves);
    for (const c of cats) {
      if (on) next.add(c);
      else next.delete(c);
    }
    onChange({ ...prefs, leaves: next });
  };

  const totalActive = prefs.leaves.size;

  return (
    <div style={{ borderBottom: "1px solid var(--panel-border)" }}>
      {/* Core bucket pills */}
      <div className={CONTROL_ROW_CLASS}>
        <div className={CONTROL_LABEL_CLASS}>
          <Shield className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
          <span
            className="text-[10px] font-semibold uppercase tracking-wider shrink-0"
            style={{ color: "var(--panel-text-muted)" }}
          >
            Avoid
          </span>
        </div>
        <div className={CONTROL_GROUP_CLASS}>
          {AVOIDANCE_CATEGORIES.map((ac) => {
            const onCount = ac.cats.filter((c) => prefs.leaves.has(c)).length;
            const total = ac.cats.length;
            const allOn = onCount === total;
            const someOn = onCount > 0;
            return (
              <button type="button"
                key={ac.id}
                onClick={() => setBucket(ac.cats, !allOn)}
                className={`shrink-0 px-2.5 py-1 rounded-full text-[10px] font-medium transition-all flex items-center gap-1 whitespace-nowrap ${
                  someOn ? "ring-1 ring-blue-500/30" : "opacity-60 hover:opacity-100"
                }`}
                style={{
                  background: someOn ? "rgba(59,130,246,0.15)" : "var(--panel-input-bg)",
                  border: `1px solid ${someOn ? "rgba(59,130,246,0.3)" : "var(--panel-border)"}`,
                  color: someOn ? "#3b82f6" : "var(--panel-text-secondary)",
                }}
                aria-pressed={someOn}
                aria-label={`Toggle ${ac.label} avoidance (${onCount} of ${total} on)`}
              >
                {ac.label}
                {total > 1 && (
                  <span
                    className="text-[9px] font-semibold opacity-80 tabular-nums"
                    aria-hidden="true"
                  >
                    {onCount}/{total}
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors"
            style={{
              background: advancedOpen ? "rgba(168,85,247,0.14)" : "var(--panel-input-bg)",
              border: `1px solid ${advancedOpen ? "rgba(168,85,247,0.35)" : "var(--panel-border)"}`,
              color: advancedOpen ? "#a855f7" : "var(--panel-text-secondary)",
            }}
            aria-expanded={advancedOpen}
          >
            <SlidersHorizontal className="w-3 h-3" />
            Advanced
            <ChevronDown
              className="w-3 h-3 transition-transform"
              style={{ transform: advancedOpen ? "rotate(180deg)" : "none" }}
            />
          </button>
        </div>
      </div>

      {advancedOpen && (
        <div style={{ background: "var(--panel-input-bg)" }}>
          <div className="px-4 pt-3 pb-1.5 space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span
                  className="text-[10px] uppercase tracking-wider font-semibold"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  Incident types
                </span>
                <span
                  className="text-[10px] tabular-nums"
                  style={{ color: "var(--panel-text-muted)" }}
                  aria-hidden="true"
                >
                  {totalActive > 0
                    ? `${totalActive} cat${totalActive === 1 ? "" : "s"} >= ${(SEVERITY_FLOORS[prefs.minSeverity] * 100).toFixed(0)}%`
                    : "off"}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2">
                {AVOIDANCE_CATEGORIES.map((bucket) => {
                  const allOn = bucket.cats.every((c) => prefs.leaves.has(c));
                  return (
                    <div key={bucket.id} className="min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="text-[10px] font-semibold" style={{ color: "var(--panel-text-secondary)" }}>
                          {bucket.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => setBucket(bucket.cats, !allOn)}
                          className="text-[10px] font-semibold text-blue-500 hover:text-blue-400"
                        >
                          {allOn ? "All off" : "All on"}
                        </button>
                      </div>
                      <div className="space-y-0.5">
                        {bucket.cats.map((leaf) => {
                          const on = prefs.leaves.has(leaf);
                          return (
                            <label
                              key={leaf}
                              className="flex items-center gap-2 cursor-pointer text-xs py-0.5"
                              style={{ color: "var(--panel-text)" }}
                            >
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => toggleLeaf(leaf)}
                                className="w-3.5 h-3.5 rounded accent-blue-500"
                              />
                              <span className="min-w-0 truncate">{LEAF_LABELS[leaf] ?? leaf.replace(/_/g, " ")}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className={CONTROL_ROW_CLASS}>
            <div className={CONTROL_LABEL_CLASS}>
              {prefs.minSeverity === "high" || prefs.minSeverity === "medium" ? (
                <ShieldAlert className="w-3.5 h-3.5 shrink-0" style={{ color: "#f59e0b" }} />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
              )}
              <span
                className="text-[10px] font-semibold uppercase tracking-wider shrink-0"
                style={{ color: "var(--panel-text-muted)" }}
              >
                Severity
              </span>
            </div>
            <div className={CONTROL_GROUP_CLASS}>
              <div
                className="flex items-center rounded-full overflow-hidden shrink-0"
                style={{ border: "1px solid var(--panel-border)" }}
                role="radiogroup"
                aria-label="Severity floor"
              >
                {FLOOR_PILLS.map((p) => {
                  const active = prefs.minSeverity === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onChange({ ...prefs, minSeverity: p.id })}
                      role="radio"
                      aria-checked={active}
                      className={`px-2.5 py-1 text-[10px] font-medium transition-colors whitespace-nowrap ${
                        active ? "" : "opacity-70 hover:opacity-100"
                      }`}
                      style={{
                        background: active ? "rgba(59,130,246,0.15)" : "transparent",
                        color: active ? "#3b82f6" : "var(--panel-text-secondary)",
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className={CONTROL_ROW_CLASS}>
            <div className={CONTROL_LABEL_CLASS}>
              <Clock className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
              <span
                className="text-[10px] font-semibold uppercase tracking-wider shrink-0"
                style={{ color: "var(--panel-text-muted)" }}
              >
                Within
              </span>
            </div>
            <div className={CONTROL_GROUP_CLASS}>
              <div
                className="flex items-center rounded-full overflow-hidden shrink-0 max-w-full"
                style={{ border: "1px solid var(--panel-border)" }}
                role="radiogroup"
                aria-label="Routing time horizon"
              >
                {AGE_PILLS.map((p) => {
                  const active =
                    (p.id == null && prefs.maxAgeHours == null) ||
                    (p.id != null && prefs.maxAgeHours === p.id);
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() =>
                        onChange({ ...prefs, maxAgeHours: p.id ?? undefined })
                      }
                      role="radio"
                      aria-checked={active}
                      className={`px-2.5 py-1 text-[10px] font-medium transition-colors whitespace-nowrap ${
                        active ? "" : "opacity-70 hover:opacity-100"
                      }`}
                      style={{
                        background: active ? "rgba(59,130,246,0.15)" : "transparent",
                        color: active ? "#3b82f6" : "var(--panel-text-secondary)",
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
