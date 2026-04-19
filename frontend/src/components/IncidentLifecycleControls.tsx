"use client";

/** "Is this still happening?" voting affordances for scanner-derived
 *  incidents. Mounted inside IncidentDetail for any incident whose
 *  id is *not* a user report.
 *
 *  Why this exists: scanner audio tells us *when* something was
 *  reported, but it can't tell us when the scene cleared. Without
 *  community ground-truth, a 4-hour-old "person down" reads the same
 *  as one from 2 minutes ago, which is the #1 thing users complain
 *  about in similar apps. A simple two-button vote — "still" or
 *  "resolved" — paired with a freshness timestamp gives a high-
 *  signal answer with very little cognitive load.
 *
 *  UX choices:
 *    - The "Still" / "Resolved" pair sits alongside the existing
 *      crowd actions so users don't have to learn a second pattern.
 *    - Tapping your existing vote retracts it (mirrors the user-
 *      report controls) so misclicks are recoverable.
 *    - Anonymous viewers see a sign-in nudge, not a write that we
 *      know Firestore will reject.
 *    - We surface the *derived* status (Still / Resolved /
 *      Unverified) as a chip so the user gets feedback even before
 *      the snapshot listener confirms their write. */

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  deriveLifecycleStatus,
  formatLastVoteAgo,
  getMyIncidentVote,
  subscribeIncidentStatus,
  voteOnIncidentStatus,
  type IncidentLifecycleAggregate,
  type IncidentVoteValue,
} from "@/lib/incident-status";

interface Props {
  incidentId: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "voting"; value: Exclude<IncidentVoteValue, null> }
  | { kind: "error"; message: string };

const EMPTY = (id: string): IncidentLifecycleAggregate => ({
  incidentId: id,
  stillCount: 0,
  resolvedCount: 0,
  lastVoteAtMs: 0,
});

export default function IncidentLifecycleControls({ incidentId }: Props) {
  const { user } = useAuth();
  const [agg, setAgg] = useState<IncidentLifecycleAggregate>(() => EMPTY(incidentId));
  const [myVote, setMyVote] = useState<IncidentVoteValue>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Bumps once per minute so the "X min ago" label stays fresh
  // without having to listen to a Firestore tick. Scoped tightly so
  // we don't re-render the whole IncidentDetail on the cadence.
  const [, setNowTick] = useState(0);

  useEffect(() => {
    setAgg(EMPTY(incidentId));
    setMyVote(null);
    setPhase({ kind: "idle" });
    if (!incidentId) return;
    const unsub = subscribeIncidentStatus(incidentId, (next) => {
      setAgg(next);
    });
    return () => unsub();
  }, [incidentId]);

  useEffect(() => {
    if (!user || user.isAnonymous || !incidentId) {
      setMyVote(null);
      return;
    }
    let cancelled = false;
    void getMyIncidentVote(incidentId, user.uid).then((v) => {
      if (!cancelled) setMyVote(v);
    });
    return () => { cancelled = true; };
  }, [incidentId, user]);

  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => (n + 1) % 1_000_000), 60_000);
    return () => clearInterval(t);
  }, []);

  const status = deriveLifecycleStatus(agg);
  const isAnon = !user || user.isAnonymous;
  const total = agg.stillCount + agg.resolvedCount;

  const cast = async (next: Exclude<IncidentVoteValue, null>) => {
    if (!user || user.isAnonymous) return;
    if (phase.kind === "voting") return;
    const target: IncidentVoteValue = myVote === next ? null : next;
    setPhase({ kind: "voting", value: next });
    const prevVote = myVote;
    const prevAgg = agg;
    // Optimistic local nudge — Firestore will overwrite via the
    // snapshot, but the chip should react instantly.
    setMyVote(target);
    setAgg((curr) => {
      const stillDelta =
        (target === "still" ? 1 : 0) - (prevVote === "still" ? 1 : 0);
      const resolvedDelta =
        (target === "resolved" ? 1 : 0) - (prevVote === "resolved" ? 1 : 0);
      return {
        incidentId: curr.incidentId,
        stillCount: Math.max(0, curr.stillCount + stillDelta),
        resolvedCount: Math.max(0, curr.resolvedCount + resolvedDelta),
        lastVoteAtMs: target ? Date.now() : curr.lastVoteAtMs,
      };
    });
    try {
      const result = await voteOnIncidentStatus(incidentId, target, {
        uid: user.uid,
        isAnonymous: user.isAnonymous,
      });
      setAgg(result);
      setPhase({ kind: "idle" });
    } catch (e) {
      setMyVote(prevVote);
      setAgg(prevAgg);
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : "Vote failed.",
      });
    }
  };

  const statusChip = (() => {
    if (status === "resolved") {
      return {
        label: "RESOLVED",
        color: "#22c55e",
        bg: "rgba(34,197,94,0.10)",
        Icon: CheckCircle2,
      };
    }
    if (status === "still") {
      return {
        label: "STILL ACTIVE",
        color: "#f59e0b",
        bg: "rgba(245,158,11,0.12)",
        Icon: CircleDashed,
      };
    }
    return {
      label: "UNCONFIRMED",
      color: "var(--panel-text-muted)",
      bg: "var(--panel-input-bg)",
      Icon: CircleDashed,
    };
  })();
  const ChipIcon = statusChip.Icon;
  const ago = formatLastVoteAgo(agg.lastVoteAtMs);

  return (
    <div
      className="rounded-lg p-3 space-y-2"
      style={{
        background: "rgba(59,130,246,0.06)",
        border: "1px solid rgba(59,130,246,0.20)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="inline-flex items-center gap-1.5 text-[10px] font-mono font-semibold tracking-wider px-2 py-0.5 rounded"
          style={{ color: statusChip.color, background: statusChip.bg }}
          title="Derived from community 'still happening' votes"
        >
          <ChipIcon className="w-3 h-3" />
          {statusChip.label}
        </span>
        <span
          className="text-[10px]"
          style={{ color: "var(--panel-text-muted)" }}
        >
          {total === 0 ? "No community votes yet" : (
            <>
              {agg.stillCount} still · {agg.resolvedCount} resolved
              {ago ? ` · last vote ${ago}` : ""}
            </>
          )}
        </span>
      </div>

      {isAnon ? (
        <p className="text-[11px] leading-snug" style={{ color: "var(--panel-text-muted)" }}>
          Sign in to mark whether this incident is still happening or has cleared.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void cast("still")}
            disabled={phase.kind === "voting"}
            className="inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              background: myVote === "still" ? "rgba(245,158,11,0.18)" : "var(--panel-input-bg)",
              color: myVote === "still" ? "#f59e0b" : "var(--panel-text)",
              border: `1px solid ${myVote === "still" ? "rgba(245,158,11,0.55)" : "var(--panel-input-border)"}`,
            }}
            title="I can see this is still happening"
          >
            {phase.kind === "voting" && phase.value === "still" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CircleDashed className="w-3.5 h-3.5" />
            )}
            Still happening
          </button>
          <button
            type="button"
            onClick={() => void cast("resolved")}
            disabled={phase.kind === "voting"}
            className="inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              background: myVote === "resolved" ? "rgba(34,197,94,0.18)" : "var(--panel-input-bg)",
              color: myVote === "resolved" ? "#22c55e" : "var(--panel-text)",
              border: `1px solid ${myVote === "resolved" ? "rgba(34,197,94,0.55)" : "var(--panel-input-border)"}`,
            }}
            title="The scene appears cleared / resolved"
          >
            {phase.kind === "voting" && phase.value === "resolved" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5" />
            )}
            Cleared / resolved
          </button>
        </div>
      )}

      {phase.kind === "error" && (
        <p
          className="flex items-start gap-1 text-[11px] leading-snug"
          style={{ color: "#ef4444" }}
        >
          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
          {phase.message}
        </p>
      )}
    </div>
  );
}
