"use client";

import { useState } from "react";
import { Wand2, Check, X } from "lucide-react";
import { optimizeStopOrder, ROUTE_OPTIMIZE_MAX_STOPS } from "@/lib/route-optimize";

interface StopRow {
  id: string;
  query: string;
  loc: { lat: number; lng: number; display_name: string } | null;
}

interface Props {
  originLoc: { lat: number; lng: number };
  destLoc: { lat: number; lng: number };
  stops: StopRow[];
  /** Called with the full new stops array when the user accepts the
   *  proposed reorder. */
  onApply: (reordered: StopRow[]) => void;
}

/** Inline "Optimize order" button that runs the brute-force TSP
 *  optimizer over the user's intermediate stops with fixed endpoints.
 *  When a meaningful improvement exists, expands into a tiny preview
 *  card showing the savings ("3.4 → 2.7 km · save 0.7 km") with
 *  Apply / Cancel actions. When already optimal, briefly shows
 *  "Already optimal" feedback. */
export default function OptimizeOrderButton({
  originLoc,
  destLoc,
  stops,
  onApply,
}: Props) {
  const [proposal, setProposal] = useState<{
    order: StopRow[];
    originalKm: number;
    optimalKm: number;
  } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const resolved = stops.filter((s): s is StopRow & { loc: NonNullable<StopRow["loc"]> } => !!s.loc);

  const handleClick = () => {
    setFeedback(null);
    if (resolved.length > ROUTE_OPTIMIZE_MAX_STOPS) {
      setFeedback(`Too many stops to optimize (max ${ROUTE_OPTIMIZE_MAX_STOPS}).`);
      setTimeout(() => setFeedback(null), 2400);
      return;
    }
    // Build OptimizableStop[] with the original row ID as payload so
    // we can rebuild the StopRow array in the optimizer's output order.
    const result = optimizeStopOrder(
      originLoc,
      resolved.map((s) => ({ lat: s.loc.lat, lng: s.loc.lng, payload: s.id })),
      destLoc
    );
    if (!result.needed) {
      setFeedback("Already in the best order.");
      setTimeout(() => setFeedback(null), 2400);
      return;
    }
    // Reattach the unresolved (no-loc) rows to the tail so the user's
    // half-typed stops aren't dropped on the floor.
    const byId = new Map(stops.map((s) => [s.id, s]));
    const reordered = [
      ...result.order.map((s) => byId.get(String(s.payload))!).filter(Boolean),
      ...stops.filter((s) => !s.loc),
    ];
    setProposal({
      order: reordered,
      originalKm: result.originalKm,
      optimalKm: result.optimalKm,
    });
  };

  const apply = () => {
    if (!proposal) return;
    onApply(proposal.order);
    setProposal(null);
    setFeedback("Applied. Refreshing route…");
    setTimeout(() => setFeedback(null), 2200);
  };

  if (proposal) {
    const saved = proposal.originalKm - proposal.optimalKm;
    return (
      <div
        className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px]"
        style={{
          background: "rgba(168,85,247,0.10)",
          border: "1px solid rgba(168,85,247,0.30)",
          color: "var(--panel-text)",
        }}
        role="dialog"
        aria-label="Confirm optimized stop order"
      >
        <Wand2 className="w-3 h-3" style={{ color: "#a855f7" }} />
        <span className="tabular-nums">
          {proposal.originalKm.toFixed(1)} → {proposal.optimalKm.toFixed(1)} km
          <span style={{ color: "#a855f7" }} className="ml-1.5 font-semibold">
            −{saved.toFixed(1)} km
          </span>
        </span>
        <button
          type="button"
          onClick={apply}
          className="inline-flex items-center justify-center w-6 h-6 rounded-md"
          style={{ background: "rgba(168,85,247,0.20)", color: "#a855f7" }}
          aria-label="Apply optimized order"
          title="Apply"
        >
          <Check className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => setProposal(null)}
          className="inline-flex items-center justify-center w-6 h-6 rounded-md"
          style={{ color: "var(--panel-text-muted)" }}
          aria-label="Discard"
          title="Discard"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors rounded-lg"
        style={{ color: "var(--panel-text-secondary)" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        title="Reorder stops to minimize total trip distance"
      >
        <Wand2 className="w-3.5 h-3.5" /> Optimize order
      </button>
      {feedback && (
        <span
          className="text-[10px] ml-1"
          style={{ color: "var(--panel-text-muted)" }}
          role="status"
        >
          {feedback}
        </span>
      )}
    </>
  );
}
