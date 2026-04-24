"use client";

/** Admin inbox for **user-submitted reports** (Firestore `feedback` rows).
 *
 *  The former two-tab layout (feedback + moderation audit log) is
 *  archived at `admin/_moderation_audit_tab.archive.tsx` for easy
 *  restoration — product request: this surface only intakes user
 *  reports; no other moderation tooling is shown here.
 *
 *  Gated in `Providers.tsx` for admin accounts. Firestore rules are
 *  the real source of truth for who can read/write. */

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  AlertTriangle,
  Loader2,
  MessageSquare,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  subscribeFeedback,
  type FeedbackEntry,
  type FeedbackStatus,
} from "@/lib/feedback";
import { auditDeleteFeedback, auditSetFeedbackStatus } from "@/lib/moderation-audit";
import { useAuth } from "@/contexts/AuthContext";

interface Props {
  onBack: () => void;
}

function fmtAgo(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

export default function ModerationPanel({ onBack }: Props) {
  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: "linear-gradient(to bottom right, #060611, #0a0a16, #060a16)" }}
    >
      <div
        className="flex items-center gap-3 px-4 py-2.5 shrink-0 relative z-10"
        style={{
          background: "rgba(255,255,255,0.02)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          backdropFilter: "blur(12px)",
        }}
      >
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: "rgba(255,255,255,0.7)" }}
          aria-label="Back to launcher"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <MessageSquare className="w-5 h-5 text-purple-400" />
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-semibold" style={{ color: "#fff" }}>
            User reports
          </span>
          <span className="text-[10px] truncate" style={{ color: "rgba(255,255,255,0.45)" }}>
            In-app feedback & bug reports only
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <FeedbackTab />
      </div>
    </div>
  );
}

// ── Feedback tab ─────────────────────────────────────────────────────

function FeedbackTab() {
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | "all">("new");
  const [rows, setRows] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    const unsub = subscribeFeedback(
      statusFilter === "all" ? {} : { status: statusFilter },
      (data) => { setRows(data); setLoading(false); setError(null); },
      (err) => { setError(err.message); setLoading(false); }
    );
    return unsub;
  }, [statusFilter]);

  const setStatus = async (row: FeedbackEntry, next: FeedbackStatus) => {
    if (!user?.uid) {
      alert("Sign in as an admin to change feedback status.");
      return;
    }
    if (row.status === next) return;
    setBusyIds((prev) => new Set(prev).add(row.id));
    try {
      await auditSetFeedbackStatus(
        row.id,
        row.status,
        next,
        row.message,
        {
          uid: user.uid,
          email: user.email ?? null,
          displayName: user.displayName ?? null,
        }
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusyIds((prev) => {
        const n = new Set(prev);
        n.delete(row.id);
        return n;
      });
    }
  };

  const handleDelete = async (row: FeedbackEntry) => {
    if (!user?.uid) {
      alert("Sign in as an admin to delete feedback.");
      return;
    }
    if (!confirm("Delete this feedback row? This is immediate.")) return;
    setBusyIds((prev) => new Set(prev).add(row.id));
    try {
      await auditDeleteFeedback(row.id, row.message, {
        uid: user.uid,
        email: user.email ?? null,
        displayName: user.displayName ?? null,
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setBusyIds((prev) => {
        const n = new Set(prev);
        n.delete(row.id);
        return n;
      });
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div
        className="flex items-center gap-2 px-4 py-2 shrink-0 text-[11px] overflow-x-auto relative z-10"
        style={{
          background: "rgba(255,255,255,0.02)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          backdropFilter: "blur(12px)",
        }}
      >
        <span style={{ color: "rgba(255,255,255,0.5)" }}>Status:</span>
        {(["all", ...FEEDBACK_STATUSES.map((s) => s.value)] as const).map((s) => {
          const meta = FEEDBACK_STATUSES.find((m) => m.value === s);
          const label = s === "all" ? "All" : meta?.label ?? s;
          const color = meta?.color ?? "#a855f7";
          const active = statusFilter === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className="px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors"
              style={{
                background: active ? `${color}22` : "rgba(255,255,255,0.04)",
                color: active ? color : "rgba(255,255,255,0.7)",
                border: `1px solid ${active ? `${color}55` : "rgba(255,255,255,0.06)"}`,
              }}
            >
              {label}
            </button>
          );
        })}
        <span className="ml-auto" style={{ color: "rgba(255,255,255,0.5)" }}>
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div
            className="flex items-center justify-center gap-2 py-12 text-xs"
            style={{ color: "rgba(255,255,255,0.5)" }}
          >
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading reports…
          </div>
        )}
        {!loading && error && (
          <div
            className="flex items-start gap-2 mx-4 my-4 p-3 rounded-lg text-xs"
            style={{ background: "rgba(239,68,68,0.10)", color: "#ef4444" }}
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              {error}
              <p className="mt-1 text-[11px] opacity-80">
                Make sure the deployed firestore.rules grant <code>read</code>
                on <code>feedback/&#123;id&#125;</code> to your admin email.
              </p>
            </div>
          </div>
        )}
        {!loading && !error && rows.length === 0 && (
          <div
            className="text-center py-12 text-xs"
            style={{ color: "rgba(255,255,255,0.5)" }}
          >
            Nothing in this bucket.
          </div>
        )}
        {rows.map((row) => {
          const kindMeta = FEEDBACK_KINDS.find((k) => k.kind === row.kind);
          const statusMeta = FEEDBACK_STATUSES.find((s) => s.value === row.status);
          return (
            <div
              key={row.id}
              className="px-4 py-3"
              style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
            >
              <div className="flex items-center gap-2 flex-wrap text-[11px]">
                <span
                  className="px-1.5 py-0.5 rounded font-bold uppercase tracking-wide"
                  style={{
                    background: "rgba(168,85,247,0.15)",
                    color: "#a855f7",
                  }}
                >
                  {kindMeta?.label ?? row.kind}
                </span>
                <span style={{ color: "#fff" }} className="font-medium">
                  {row.ownerDisplayName || row.ownerEmail || "Anonymous"}
                </span>
                {row.contactEmail && row.contactEmail !== row.ownerEmail && (
                  <span style={{ color: "rgba(255,255,255,0.5)" }}>
                    contact: {row.contactEmail}
                  </span>
                )}
                <span style={{ color: "rgba(255,255,255,0.5)" }}>·</span>
                <span style={{ color: "rgba(255,255,255,0.5)" }} title={new Date(row.createdAtMs).toString()}>
                  {fmtAgo(row.createdAtMs)}
                </span>
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
                  style={{
                    background: `${statusMeta?.color ?? "#3b82f6"}22`,
                    color: statusMeta?.color ?? "#3b82f6",
                  }}
                >
                  {statusMeta?.label ?? row.status}
                </span>
              </div>
              <p
                className="mt-1.5 text-[12px] leading-snug whitespace-pre-wrap"
                style={{ color: "#fff" }}
              >
                {row.message}
              </p>
              <div
                className="mt-1.5 flex items-center gap-2 flex-wrap text-[10px] font-mono"
                style={{ color: "rgba(255,255,255,0.5)" }}
              >
                <span>v{row.appVersion}</span>
                {(row.context.viewport as string | undefined) && (
                  <span>· {String(row.context.viewport)}</span>
                )}
                {(row.context.city as string | undefined) && (
                  <span>· city: {String(row.context.city)}</span>
                )}
                {(row.context.online as boolean | undefined) === false && (
                  <span style={{ color: "#f59e0b" }}>· offline at submit</span>
                )}
                {row.ownerIsAnonymous && (
                  <span style={{ color: "#f59e0b" }}>· anon</span>
                )}
                {(row.context.url as string | undefined) && (
                  <span className="truncate max-w-[260px]">
                    · {String(row.context.url)}
                  </span>
                )}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <select
                  value={row.status}
                  onChange={(e) => void setStatus(row, e.target.value as FeedbackStatus)}
                  disabled={busyIds.has(row.id)}
                  className="px-2 py-1 rounded text-[11px] disabled:opacity-50"
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    color: "#fff",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  {FEEDBACK_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
                {busyIds.has(row.id) && (
                  <RefreshCw className="w-3 h-3 animate-spin" style={{ color: "rgba(255,255,255,0.5)" }} />
                )}
                <button
                  type="button"
                  onClick={() => void handleDelete(row)}
                  disabled={busyIds.has(row.id)}
                  className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium disabled:opacity-50"
                  style={{
                    background: "rgba(239,68,68,0.10)",
                    color: "#ef4444",
                    border: "1px solid rgba(239,68,68,0.30)",
                  }}
                >
                  <Trash2 className="w-3 h-3" />
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

