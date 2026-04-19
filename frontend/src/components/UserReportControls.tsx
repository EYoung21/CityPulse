"use client";

/** Per-report voting + owner-delete affordances, shown inside
 *  IncidentDetail when the selected incident is a user-submitted
 *  report (id starts with `user-`).
 *
 *  Goals:
 *    - Make it 1-tap to confirm or dispute, with the current net
 *      score visible at all times.
 *    - Hide the buttons for the report's owner (they can't vote on
 *      themselves, and Firestore rules will reject the write
 *      anyway). They get a "Remove report" affordance instead.
 *    - Anonymous viewers see a sign-in nudge instead of a write that
 *      we know will fail.
 *    - Treat double-tap on the same vote as a retraction so the user
 *      can undo a misclick without searching for a separate control.
 */

import { useEffect, useState } from "react";
import { ThumbsUp, ThumbsDown, Loader2, Trash2, AlertCircle, UserCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  dismissOwnReport,
  getMyVote,
  isUserReportIncidentId,
  userReportIdFromIncidentId,
  voteOnUserReport,
  type UserReport,
  type UserReportVoteValue,
} from "@/lib/user-reports";

interface Props {
  /** The Incident-shaped row from page.tsx — its `id` starts with
   *  `user-` for crowdsourced reports. */
  incidentId: string;
  /** Current report metadata (live from `userReports` subscription).
   *  Pass `null` while loading or when the report no longer exists. */
  report: UserReport | null;
  /** Called when the report has been deleted by its owner so the
   *  containing card can close itself. */
  onDeleted?: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "voting"; value: UserReportVoteValue }
  | { kind: "deleting" }
  | { kind: "error"; message: string };

export default function UserReportControls({ incidentId, report, onDeleted }: Props) {
  const { user } = useAuth();
  const [myVote, setMyVote] = useState<UserReportVoteValue>(0);
  const [optimisticNet, setOptimisticNet] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Pull the viewer's existing vote once when the report changes —
  // the subscribed `report.confirmCount/disputeCount` is enough for
  // the headline number, but we need a per-user read to know which
  // button to render as "selected".
  useEffect(() => {
    setMyVote(0);
    setOptimisticNet(null);
    setStatus({ kind: "idle" });
    if (!report || !user || user.isAnonymous) return;
    let cancelled = false;
    void getMyVote(report.id, user.uid).then((v) => {
      if (!cancelled) setMyVote(v);
    });
    return () => { cancelled = true; };
  }, [report, user]);

  if (!isUserReportIncidentId(incidentId)) return null;
  if (!report) {
    // We know it's a user report by id but the data hasn't arrived
    // (or it was just deleted). Render a neutral placeholder rather
    // than nothing so the popup doesn't visually "jump".
    return (
      <div
        className="rounded-lg p-3 text-[11px] flex items-center gap-2"
        style={{ background: "var(--panel-input-bg)", color: "var(--panel-text-muted)" }}
      >
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading crowdsourced report…
      </div>
    );
  }

  const net = optimisticNet ?? report.confirmCount - report.disputeCount;
  const isOwner = !!user && report.ownerUid === user.uid;
  const isAnon = !user || user.isAnonymous;

  const cast = async (v: UserReportVoteValue) => {
    if (!user || user.isAnonymous) return;
    if (status.kind === "voting" || status.kind === "deleting") return;
    // If you tap your existing vote, it retracts — treat it as a
    // toggle so users can undo a misclick without hunting for a
    // separate control.
    const target: UserReportVoteValue = myVote === v ? 0 : v;
    setStatus({ kind: "voting", value: target });
    // Optimistic local update so the chip jumps before the round-
    // trip; the snapshot listener will reconcile if the transaction
    // fails or sees a concurrent vote.
    const prevVote = myVote;
    setMyVote(target);
    const delta = (target === 1 ? 1 : 0) - (prevVote === 1 ? 1 : 0)
                  - (target === -1 ? 1 : 0) + (prevVote === -1 ? 1 : 0);
    setOptimisticNet(net + delta);
    try {
      const result = await voteOnUserReport(
        userReportIdFromIncidentId(incidentId),
        target,
        { uid: user.uid, isAnonymous: user.isAnonymous }
      );
      setOptimisticNet(result);
      setStatus({ kind: "idle" });
    } catch (e) {
      setMyVote(prevVote);
      setOptimisticNet(null);
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Vote failed.",
      });
    }
  };

  const remove = async () => {
    if (!isOwner) return;
    if (status.kind === "deleting") return;
    setStatus({ kind: "deleting" });
    try {
      await dismissOwnReport(userReportIdFromIncidentId(incidentId));
      onDeleted?.();
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Couldn't remove report.",
      });
    }
  };

  return (
    <div
      className="rounded-lg p-3 space-y-2"
      style={{
        background: "rgba(168,85,247,0.06)",
        border: "1px solid rgba(168,85,247,0.25)",
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--panel-text)" }}>
          <UserCircle className="w-3.5 h-3.5" style={{ color: "#a855f7" }} />
          <span className="font-medium">{report.ownerName || "Reporter"}</span>
          <span style={{ color: "var(--panel-text-muted)" }}>· crowdsourced</span>
        </div>
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded"
          style={{
            color: net > 0 ? "#22c55e" : net < 0 ? "#ef4444" : "var(--panel-text-muted)",
            background:
              net > 0 ? "rgba(34,197,94,0.10)" :
              net < 0 ? "rgba(239,68,68,0.10)" :
              "var(--panel-input-bg)",
          }}
          title="Community trust score (confirms minus disputes)"
        >
          {net > 0 ? `+${net}` : net}
        </span>
      </div>

      {isOwner ? (
        <button
          type="button"
          onClick={() => void remove()}
          disabled={status.kind === "deleting"}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
          style={{
            background: "rgba(239,68,68,0.10)",
            color: "#ef4444",
            border: "1px solid rgba(239,68,68,0.30)",
          }}
        >
          {status.kind === "deleting" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Trash2 className="w-3.5 h-3.5" />
          )}
          Remove this report
        </button>
      ) : isAnon ? (
        <p className="text-[11px] leading-snug" style={{ color: "var(--panel-text-muted)" }}>
          Sign in to confirm or dispute this report. Reports below −3 net votes are auto-hidden from the map.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void cast(1)}
            disabled={status.kind === "voting" || status.kind === "deleting"}
            className="inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              background: myVote === 1 ? "rgba(34,197,94,0.18)" : "var(--panel-input-bg)",
              color: myVote === 1 ? "#22c55e" : "var(--panel-text)",
              border: `1px solid ${myVote === 1 ? "rgba(34,197,94,0.55)" : "var(--panel-input-border)"}`,
            }}
            title="I see this too"
          >
            {status.kind === "voting" && status.value === 1 ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ThumbsUp className="w-3.5 h-3.5" />
            )}
            Confirm
          </button>
          <button
            type="button"
            onClick={() => void cast(-1)}
            disabled={status.kind === "voting" || status.kind === "deleting"}
            className="inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              background: myVote === -1 ? "rgba(239,68,68,0.18)" : "var(--panel-input-bg)",
              color: myVote === -1 ? "#ef4444" : "var(--panel-text)",
              border: `1px solid ${myVote === -1 ? "rgba(239,68,68,0.55)" : "var(--panel-input-border)"}`,
            }}
            title="Not seeing this / looks resolved"
          >
            {status.kind === "voting" && status.value === -1 ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ThumbsDown className="w-3.5 h-3.5" />
            )}
            Dispute
          </button>
        </div>
      )}

      {status.kind === "error" && (
        <p
          className="flex items-start gap-1 text-[11px] leading-snug"
          style={{ color: "#ef4444" }}
        >
          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
          {status.message}
        </p>
      )}
    </div>
  );
}
