"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Clock, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
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

/** Detailed avoidance picker: a row of expandable bucket pills (each
 *  showing "X/Y" leaves on), and below it a 4-stop severity floor that
 *  gates everything regardless of which leaves are selected. Designed
 *  to fit inside the existing Directions panel without a modal. */
export default function AvoidancePrefsPicker({ prefs, onChange }: Props) {
  const [expandedBucket, setExpandedBucket] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Tap-outside auto-collapse so the panel doesn't stay open and steal
  // tap targets from the form fields below it.
  useEffect(() => {
    if (!expandedBucket) return;
    const onDoc = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setExpandedBucket(null);
      }
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [expandedBucket]);

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
    <div ref={containerRef} style={{ borderBottom: "1px solid var(--panel-border)" }}>
      {/* Bucket pills with chevrons */}
      <div className="px-4 py-2.5 flex items-center gap-2 overflow-x-auto no-scrollbar">
        <Shield className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
        <span
          className="text-[10px] font-semibold uppercase tracking-wider shrink-0"
          style={{ color: "var(--panel-text-muted)" }}
        >
          Avoid
        </span>
        {AVOIDANCE_CATEGORIES.map((ac) => {
          const onCount = ac.cats.filter((c) => prefs.leaves.has(c)).length;
          const total = ac.cats.length;
          const allOn = onCount === total;
          const someOn = onCount > 0;
          const isExpanded = expandedBucket === ac.id;
          return (
            <div key={ac.id} className="shrink-0 inline-flex items-stretch">
              <button
                onClick={() => setBucket(ac.cats, !allOn)}
                className={`pl-2.5 pr-1.5 py-1 rounded-l-full text-[10px] font-medium transition-all flex items-center gap-1 ${
                  someOn ? "ring-1 ring-blue-500/30" : "opacity-60 hover:opacity-100"
                }`}
                style={{
                  background: someOn ? "rgba(59,130,246,0.15)" : "var(--panel-input-bg)",
                  borderTop: `1px solid ${someOn ? "rgba(59,130,246,0.3)" : "var(--panel-border)"}`,
                  borderBottom: `1px solid ${someOn ? "rgba(59,130,246,0.3)" : "var(--panel-border)"}`,
                  borderLeft: `1px solid ${someOn ? "rgba(59,130,246,0.3)" : "var(--panel-border)"}`,
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
              {/* Hide the per-leaf chevron when there's only one leaf
                  (e.g. Fire) — the bucket toggle is the leaf toggle. */}
              {total > 1 ? (
                <button
                  onClick={() => setExpandedBucket(isExpanded ? null : ac.id)}
                  className="px-1.5 py-1 rounded-r-full text-[10px] transition-all"
                  style={{
                    background: someOn ? "rgba(59,130,246,0.15)" : "var(--panel-input-bg)",
                    borderTop: `1px solid ${someOn ? "rgba(59,130,246,0.3)" : "var(--panel-border)"}`,
                    borderBottom: `1px solid ${someOn ? "rgba(59,130,246,0.3)" : "var(--panel-border)"}`,
                    borderRight: `1px solid ${someOn ? "rgba(59,130,246,0.3)" : "var(--panel-border)"}`,
                    color: someOn ? "#3b82f6" : "var(--panel-text-muted)",
                  }}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${ac.label} sub-categories`}
                  aria-expanded={isExpanded}
                >
                  <ChevronDown
                    className="w-3 h-3 transition-transform"
                    style={{ transform: isExpanded ? "rotate(180deg)" : "none" }}
                  />
                </button>
              ) : (
                // Visual end-cap so single-leaf pills look the same shape
                // as expandable ones.
                <span
                  className="px-1.5 py-1 rounded-r-full"
                  style={{
                    background: someOn ? "rgba(59,130,246,0.15)" : "var(--panel-input-bg)",
                    borderTop: `1px solid ${someOn ? "rgba(59,130,246,0.3)" : "var(--panel-border)"}`,
                    borderBottom: `1px solid ${someOn ? "rgba(59,130,246,0.3)" : "var(--panel-border)"}`,
                    borderRight: `1px solid ${someOn ? "rgba(59,130,246,0.3)" : "var(--panel-border)"}`,
                  }}
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Per-leaf checklist for the expanded bucket */}
      {expandedBucket &&
        (() => {
          const bucket = AVOIDANCE_CATEGORIES.find((b) => b.id === expandedBucket);
          if (!bucket) return null;
          const allOn = bucket.cats.every((c) => prefs.leaves.has(c));
          return (
            <div
              className="px-4 pb-3 -mt-1 flex flex-col gap-1.5"
              style={{ background: "var(--panel-input-bg)" }}
            >
              <div className="flex items-center justify-between pt-2">
                <span
                  className="text-[10px] uppercase tracking-wider font-semibold"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  {bucket.label} categories
                </span>
                <button
                  type="button"
                  onClick={() => setBucket(bucket.cats, !allOn)}
                  className="text-[10px] font-semibold text-blue-500 hover:text-blue-400"
                >
                  {allOn ? "Turn all off" : "Turn all on"}
                </button>
              </div>
              {bucket.cats.map((leaf) => {
                const on = prefs.leaves.has(leaf);
                return (
                  <label
                    key={leaf}
                    className="flex items-center gap-2 cursor-pointer text-xs py-1"
                    style={{ color: "var(--panel-text)" }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleLeaf(leaf)}
                      className="w-3.5 h-3.5 rounded accent-blue-500"
                    />
                    <span>{LEAF_LABELS[leaf] ?? leaf.replace(/_/g, " ")}</span>
                  </label>
                );
              })}
            </div>
          );
        })()}

      {/* Severity floor selector */}
      <div className="px-4 py-2.5 flex items-center gap-2">
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
                className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${
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
        <span
          className="text-[10px] tabular-nums shrink-0"
          style={{ color: "var(--panel-text-muted)" }}
          aria-hidden="true"
        >
          {totalActive > 0
            ? `${totalActive} cat${totalActive === 1 ? "" : "s"} ≥ ${(SEVERITY_FLOORS[prefs.minSeverity] * 100).toFixed(0)}%`
            : "off"}
        </span>
      </div>

      {/* Routing time horizon — how far back to consider incidents when
          building avoid zones. Independent of the global map filter so
          users can route conservatively (e.g. "avoid anything in the
          last 6h") even while viewing a tighter window. */}
      <div className="px-4 py-2.5 flex items-center gap-2 overflow-x-auto no-scrollbar">
        <Clock className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
        <span
          className="text-[10px] font-semibold uppercase tracking-wider shrink-0"
          style={{ color: "var(--panel-text-muted)" }}
        >
          Within
        </span>
        <div
          className="flex items-center rounded-full overflow-hidden shrink-0"
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
                className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${
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
  );
}
