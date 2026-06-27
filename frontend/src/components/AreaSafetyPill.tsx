"use client";

import { ShieldCheck, AlertTriangle, ShieldAlert } from "lucide-react";
import type { Incident } from "@/lib/api";

/**
 * Always-on "is this area safe right now?" glance. Reads the incidents
 * currently in the map viewport (already filtered by the active time window)
 * and renders one subtle pill: Quiet / Elevated / Active. This is the question
 * people actually open a safety map for — so we answer it without making them
 * dig into a panel.
 *
 * Thresholds are deliberately conservative so "Quiet" stays the common case:
 *   - quiet:    nothing, or ≤2 incidents and none high-severity
 *   - active:   ≥3 high-severity incidents, or ≥12 total in view
 *   - elevated: everything in between
 */
export default function AreaSafetyPill({ incidents }: { incidents: Incident[] }) {
  const n = incidents.length;
  let highSev = 0;
  for (const inc of incidents) if ((inc.s_base ?? 0) >= 0.7) highSev++;

  const level: "quiet" | "elevated" | "active" =
    n === 0 || (n <= 2 && highSev === 0)
      ? "quiet"
      : highSev >= 3 || n >= 12
        ? "active"
        : "elevated";

  const cfg = {
    quiet: { Icon: ShieldCheck, label: "Quiet", color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
    elevated: { Icon: AlertTriangle, label: "Elevated", color: "#f59e0b", bg: "rgba(245,158,11,0.14)" },
    active: { Icon: ShieldAlert, label: "Active", color: "#ef4444", bg: "rgba(239,68,68,0.14)" },
  }[level];
  const { Icon } = cfg;

  return (
    <div
      className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg backdrop-blur-md"
      style={{ background: cfg.bg, border: `1px solid ${cfg.color}55`, color: cfg.color }}
      title={`${n} incident${n === 1 ? "" : "s"} in view, current time window`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      This area: {cfg.label}
      {n > 0 && <span className="opacity-70 font-normal">· {n}</span>}
    </div>
  );
}
