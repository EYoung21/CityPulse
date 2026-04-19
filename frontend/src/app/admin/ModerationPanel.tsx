"use client";

/** Moderation surface for crowdsourced reports + in-app feedback.
 *
 *  Two tabs:
 *    1. **User reports** — every `userReports` row in the current
 *       city (no client-side `expiresAt` or HIDE_THRESHOLD pruning),
 *       sortable by net votes, with a 1-tap "delete" that removes
 *       the row from Firestore. Useful for taking down obviously
 *       abusive submissions before the community votes them out.
 *    2. **Feedback** — every `feedback` row, grouped by triage state
 *       (new / triaged / resolved / wontfix). Each row exposes a
 *       status dropdown and a delete button.
 *
 *  The view is gated on the launcher level (Providers.tsx only
 *  renders ModerationPanel for admin users). Firestore rules are the
 *  real source of truth — non-admins that hit the page directly
 *  would still get permission errors on every read.
 *
 *  Performance: both subscriptions cap at a few hundred rows so
 *  large backlogs don't melt the browser. If the inbox ever exceeds
 *  that we'll add server-side pagination instead of bumping the
 *  cap. */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  AlertTriangle,
  ClipboardList,
  Loader2,
  MapPin,
  MessageSquare,
  Megaphone,
  RefreshCw,
  Send,
  Trash2,
  Users,
} from "lucide-react";
import {
  HIDE_THRESHOLD,
  subscribeAllUserReportsForAdmin,
  USER_REPORT_CATEGORIES,
  type UserReport,
} from "@/lib/user-reports";
import {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  subscribeFeedback,
  type FeedbackEntry,
  type FeedbackStatus,
} from "@/lib/feedback";
import {
  auditDeleteFeedback,
  auditDeleteUserReport,
  auditPushBroadcast,
  auditSetFeedbackStatus,
  describeAuditAction,
  subscribeModerationAudit,
  type ModerationAuditEntry,
} from "@/lib/moderation-audit";
import {
  previewBroadcastRecipients,
  sendBroadcast,
} from "@/lib/push-subscriptions";
import { getCurrentCity, PULSE_CITIES } from "@/lib/pulse-cities";
import { useAuth } from "@/contexts/AuthContext";

interface Props {
  onBack: () => void;
}

type Tab = "reports" | "feedback" | "audit" | "broadcast";

function fmtAgo(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

function categoryMeta(slug: string) {
  return USER_REPORT_CATEGORIES.find((c) => c.severity === slug);
}

export default function ModerationPanel({ onBack }: Props) {
  const [tab, setTab] = useState<Tab>("reports");
  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: "var(--map-bg, #0a0a14)" }}
    >
      <div
        className="flex items-center gap-3 px-4 py-2.5 shrink-0"
        style={{
          background: "var(--panel-bg, rgba(15,15,25,0.95))",
          borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.08))",
        }}
      >
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: "var(--panel-text-secondary)" }}
          aria-label="Back to launcher"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Users className="w-5 h-5 text-purple-400" />
        <span className="text-sm font-semibold" style={{ color: "var(--panel-text)" }}>
          Moderation
        </span>

        <div
          className="ml-4 flex items-center gap-1 p-0.5 rounded-lg"
          style={{ background: "var(--panel-input-bg, rgba(255,255,255,0.04))" }}
        >
          <button
            type="button"
            onClick={() => setTab("reports")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === "reports" ? "bg-purple-500 text-white" : ""
            }`}
            style={tab === "reports" ? {} : { color: "var(--panel-text-secondary)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="w-3 h-3" />
              User reports
            </span>
          </button>
          <button
            type="button"
            onClick={() => setTab("feedback")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === "feedback" ? "bg-purple-500 text-white" : ""
            }`}
            style={tab === "feedback" ? {} : { color: "var(--panel-text-secondary)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              <MessageSquare className="w-3 h-3" />
              Feedback
            </span>
          </button>
          <button
            type="button"
            onClick={() => setTab("audit")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === "audit" ? "bg-purple-500 text-white" : ""
            }`}
            style={tab === "audit" ? {} : { color: "var(--panel-text-secondary)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              <ClipboardList className="w-3 h-3" />
              Audit log
            </span>
          </button>
          <button
            type="button"
            onClick={() => setTab("broadcast")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === "broadcast" ? "bg-purple-500 text-white" : ""
            }`}
            style={tab === "broadcast" ? {} : { color: "var(--panel-text-secondary)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              <Megaphone className="w-3 h-3" />
              Broadcast
            </span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === "reports" ? (
          <ReportsTab />
        ) : tab === "feedback" ? (
          <FeedbackTab />
        ) : tab === "broadcast" ? (
          <BroadcastTab />
        ) : (
          <AuditTab />
        )}
      </div>
    </div>
  );
}

// ── User reports tab ─────────────────────────────────────────────────

function ReportsTab() {
  const { user } = useAuth();
  const [reports, setReports] = useState<UserReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<"newest" | "score" | "disputed">("newest");

  useEffect(() => {
    setLoading(true);
    const unsub = subscribeAllUserReportsForAdmin(
      (rows) => { setReports(rows); setLoading(false); setError(null); },
      (err) => { setError(err.message); setLoading(false); }
    );
    return unsub;
  }, []);

  const sorted = useMemo(() => {
    const copy = [...reports];
    if (sort === "score") {
      copy.sort((a, b) => (b.confirmCount - b.disputeCount) - (a.confirmCount - a.disputeCount));
    } else if (sort === "disputed") {
      copy.sort((a, b) => (a.confirmCount - a.disputeCount) - (b.confirmCount - b.disputeCount));
    } else {
      copy.sort((a, b) => b.createdAtMs - a.createdAtMs);
    }
    return copy;
  }, [reports, sort]);

  const handleDelete = async (r: UserReport) => {
    if (!user?.uid) {
      alert("Sign in as an admin to delete reports.");
      return;
    }
    if (!confirm("Delete this report? This is immediate and can't be undone.")) return;
    setBusyIds((prev) => new Set(prev).add(r.id));
    try {
      // Snippet captures category + (truncated) note so the audit
      // log entry remains useful after the source row is gone.
      const meta = categoryMeta(r.category);
      const snippet = `${meta?.label ?? r.category}${r.note ? ` — ${r.note}` : ""}`;
      await auditDeleteUserReport(
        r.id,
        snippet,
        {
          uid: user.uid,
          email: user.email ?? null,
          displayName: user.displayName ?? null,
        },
        {
          category: r.category,
          ownerUid: r.ownerUid,
          ownerName: r.ownerName ?? null,
          lat: r.lat,
          lng: r.lng,
          confirmCount: r.confirmCount,
          disputeCount: r.disputeCount,
          createdAtMs: r.createdAtMs,
        }
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(r.id);
        return next;
      });
    }
  };

  const buried = sorted.filter((r) => r.confirmCount - r.disputeCount <= HIDE_THRESHOLD).length;
  const expired = sorted.filter((r) => r.expiresAtMs <= Date.now()).length;

  return (
    <div className="h-full flex flex-col">
      <div
        className="flex items-center gap-3 px-4 py-2 shrink-0 text-[11px]"
        style={{
          background: "var(--panel-bg, rgba(15,15,25,0.85))",
          borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.06))",
          color: "var(--panel-text-muted)",
        }}
      >
        <span>{sorted.length} total</span>
        {buried > 0 && (
          <span style={{ color: "#ef4444" }}>· {buried} hidden by votes</span>
        )}
        {expired > 0 && (
          <span style={{ color: "#f59e0b" }}>· {expired} past TTL</span>
        )}
        <div className="ml-auto inline-flex items-center gap-1">
          <span>Sort:</span>
          {([
            ["newest", "Newest"],
            ["score", "Highest score"],
            ["disputed", "Most disputed"],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setSort(k)}
              className="px-2 py-0.5 rounded transition-colors"
              style={{
                background: sort === k ? "rgba(168,85,247,0.18)" : "transparent",
                color: sort === k ? "#a855f7" : "var(--panel-text-muted)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div
            className="flex items-center justify-center gap-2 py-12 text-xs"
            style={{ color: "var(--panel-text-muted)" }}
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
                Check that you&rsquo;re signed in with an admin account and that
                Firestore rules have been deployed (firestore.rules).
              </p>
            </div>
          </div>
        )}
        {!loading && !error && sorted.length === 0 && (
          <div
            className="text-center py-12 text-xs"
            style={{ color: "var(--panel-text-muted)" }}
          >
            No reports in this city yet.
          </div>
        )}
        <div className="divide-y" style={{ borderColor: "var(--panel-border)" }}>
          {sorted.map((r) => {
            const meta = categoryMeta(r.category);
            const net = r.confirmCount - r.disputeCount;
            const buried = net <= HIDE_THRESHOLD;
            const expired = r.expiresAtMs <= Date.now();
            return (
              <div
                key={r.id}
                className="px-4 py-3 flex items-start gap-3"
                style={{
                  background: buried || expired ? "rgba(239,68,68,0.04)" : "transparent",
                  borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.05))",
                }}
              >
                <div
                  className="text-base shrink-0 w-6 text-center"
                  aria-hidden="true"
                >
                  {meta?.glyph ?? "•"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap text-[11px]">
                    <span
                      className="font-semibold"
                      style={{ color: "var(--panel-text)" }}
                    >
                      {meta?.label ?? r.category}
                    </span>
                    <span style={{ color: "var(--panel-text-muted)" }}>·</span>
                    <span style={{ color: "var(--panel-text-secondary)" }}>
                      {r.ownerName || "Reporter"}
                    </span>
                    <span style={{ color: "var(--panel-text-muted)" }}>·</span>
                    <span style={{ color: "var(--panel-text-muted)" }} title={new Date(r.createdAtMs).toString()}>
                      {fmtAgo(r.createdAtMs)}
                    </span>
                    <span
                      className="ml-1 px-1.5 py-0.5 rounded font-mono"
                      style={{
                        color: net > 0 ? "#22c55e" : net < 0 ? "#ef4444" : "var(--panel-text-muted)",
                        background:
                          net > 0 ? "rgba(34,197,94,0.10)" :
                          net < 0 ? "rgba(239,68,68,0.10)" :
                          "var(--panel-input-bg)",
                      }}
                    >
                      {net > 0 ? `+${net}` : net} ({r.confirmCount}/{r.disputeCount})
                    </span>
                    {buried && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
                        style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}
                      >
                        Hidden
                      </span>
                    )}
                    {expired && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
                        style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}
                      >
                        Expired
                      </span>
                    )}
                  </div>
                  {r.note && (
                    <p
                      className="mt-1 text-[12px] leading-snug whitespace-pre-wrap"
                      style={{ color: "var(--panel-text)" }}
                    >
                      {r.note}
                    </p>
                  )}
                  <div
                    className="mt-1 flex items-center gap-3 text-[10px] font-mono"
                    style={{ color: "var(--panel-text-muted)" }}
                  >
                    <a
                      href={`https://www.google.com/maps?q=${r.lat},${r.lng}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {r.lat.toFixed(5)}, {r.lng.toFixed(5)}
                    </a>
                    <span>uid: {r.ownerUid.slice(0, 8)}…</span>
                    <span>id: {r.id.slice(0, 8)}…</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(r)}
                  disabled={busyIds.has(r.id)}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium disabled:opacity-50"
                  style={{
                    background: "rgba(239,68,68,0.10)",
                    color: "#ef4444",
                    border: "1px solid rgba(239,68,68,0.30)",
                  }}
                >
                  {busyIds.has(r.id) ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Trash2 className="w-3 h-3" />
                  )}
                  Delete
                </button>
              </div>
            );
          })}
        </div>
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
        className="flex items-center gap-2 px-4 py-2 shrink-0 text-[11px] overflow-x-auto"
        style={{
          background: "var(--panel-bg, rgba(15,15,25,0.85))",
          borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.06))",
        }}
      >
        <span style={{ color: "var(--panel-text-muted)" }}>Status:</span>
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
                background: active ? `${color}22` : "var(--panel-input-bg)",
                color: active ? color : "var(--panel-text-secondary)",
                border: `1px solid ${active ? `${color}55` : "var(--panel-border)"}`,
              }}
            >
              {label}
            </button>
          );
        })}
        <span className="ml-auto" style={{ color: "var(--panel-text-muted)" }}>
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div
            className="flex items-center justify-center gap-2 py-12 text-xs"
            style={{ color: "var(--panel-text-muted)" }}
          >
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading feedback…
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
            style={{ color: "var(--panel-text-muted)" }}
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
              style={{ borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.05))" }}
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
                <span style={{ color: "var(--panel-text)" }} className="font-medium">
                  {row.ownerDisplayName || row.ownerEmail || "Anonymous"}
                </span>
                {row.contactEmail && row.contactEmail !== row.ownerEmail && (
                  <span style={{ color: "var(--panel-text-muted)" }}>
                    contact: {row.contactEmail}
                  </span>
                )}
                <span style={{ color: "var(--panel-text-muted)" }}>·</span>
                <span style={{ color: "var(--panel-text-muted)" }} title={new Date(row.createdAtMs).toString()}>
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
                style={{ color: "var(--panel-text)" }}
              >
                {row.message}
              </p>
              <div
                className="mt-1.5 flex items-center gap-2 flex-wrap text-[10px] font-mono"
                style={{ color: "var(--panel-text-muted)" }}
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
                    background: "var(--panel-input-bg)",
                    color: "var(--panel-text)",
                    border: "1px solid var(--panel-border)",
                  }}
                >
                  {FEEDBACK_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
                {busyIds.has(row.id) && (
                  <RefreshCw className="w-3 h-3 animate-spin" style={{ color: "var(--panel-text-muted)" }} />
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

// ── Audit log tab ────────────────────────────────────────────────────

function AuditTab() {
  const [rows, setRows] = useState<ModerationAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<
    "all" | ModerationAuditEntry["kind"]
  >("all");

  useEffect(() => {
    setLoading(true);
    const unsub = subscribeModerationAudit(
      kindFilter === "all" ? {} : { kind: kindFilter },
      (data) => { setRows(data); setLoading(false); setError(null); },
      (err) => { setError(err.message); setLoading(false); }
    );
    return unsub;
  }, [kindFilter]);

  const KINDS: {
    value: "all" | ModerationAuditEntry["kind"];
    label: string;
    color: string;
  }[] = [
    { value: "all",                 label: "All",        color: "#a855f7" },
    { value: "userReport.delete",   label: "Report deletes", color: "#ef4444" },
    { value: "feedback.delete",     label: "Feedback deletes", color: "#ef4444" },
    { value: "feedback.status",     label: "Status changes", color: "#3b82f6" },
  ];

  return (
    <div className="h-full flex flex-col">
      <div
        className="flex items-center gap-2 px-4 py-2 shrink-0 text-[11px] overflow-x-auto"
        style={{
          background: "var(--panel-bg, rgba(15,15,25,0.85))",
          borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.06))",
        }}
      >
        <span style={{ color: "var(--panel-text-muted)" }}>Filter:</span>
        {KINDS.map((k) => {
          const active = kindFilter === k.value;
          return (
            <button
              key={k.value}
              type="button"
              onClick={() => setKindFilter(k.value)}
              className="px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors"
              style={{
                background: active ? `${k.color}22` : "var(--panel-input-bg)",
                color: active ? k.color : "var(--panel-text-secondary)",
                border: `1px solid ${active ? `${k.color}55` : "var(--panel-border)"}`,
              }}
            >
              {k.label}
            </button>
          );
        })}
        <span className="ml-auto" style={{ color: "var(--panel-text-muted)" }}>
          {rows.length} entr{rows.length === 1 ? "y" : "ies"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div
            className="flex items-center justify-center gap-2 py-12 text-xs"
            style={{ color: "var(--panel-text-muted)" }}
          >
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading audit log…
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
                The audit feed requires the deployed firestore.rules to grant
                <code> read </code> on <code>moderationAudit/&#123;id&#125;</code>
                to your admin email.
              </p>
            </div>
          </div>
        )}
        {!loading && !error && rows.length === 0 && (
          <div
            className="text-center py-12 text-xs"
            style={{ color: "var(--panel-text-muted)" }}
          >
            No audit entries yet. Moderation actions you take will appear here.
          </div>
        )}
        {rows.map((entry) => (
          <div
            key={entry.id}
            className="px-4 py-2.5"
            style={{ borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.05))" }}
          >
            <div className="flex items-center gap-2 flex-wrap text-[11px]">
              <span
                className="px-1.5 py-0.5 rounded font-mono uppercase"
                style={{
                  background: entry.kind.endsWith(".delete")
                    ? "rgba(239,68,68,0.15)"
                    : "rgba(59,130,246,0.15)",
                  color: entry.kind.endsWith(".delete") ? "#ef4444" : "#3b82f6",
                }}
              >
                {describeAuditAction(entry)}
              </span>
              <span style={{ color: "var(--panel-text)" }} className="font-medium">
                {entry.actorDisplayName || entry.actorEmail || entry.actorUid.slice(0, 8) + "…"}
              </span>
              <span style={{ color: "var(--panel-text-muted)" }} title={new Date(entry.createdAtMs).toString()}>
                · {fmtAgo(entry.createdAtMs)}
              </span>
            </div>
            {entry.targetSnippet && (
              <p
                className="mt-1 text-[12px] leading-snug whitespace-pre-wrap"
                style={{ color: "var(--panel-text-secondary)" }}
              >
                &ldquo;{entry.targetSnippet}&rdquo;
              </p>
            )}
            {/* Structured snapshot for report deletes — gives "what
                exactly was removed" at a glance, even after the
                source row is gone. We render it as a compact pill
                row instead of a full table so the audit feed stays
                scannable. */}
            {entry.kind === "userReport.delete" && entry.payload && (
              <div
                className="mt-1.5 flex items-center gap-2 flex-wrap text-[10px]"
                style={{ color: "var(--panel-text-muted)" }}
              >
                {typeof entry.payload.category === "string" && (
                  <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--panel-input-bg)" }}>
                    {String(entry.payload.category)}
                  </span>
                )}
                {typeof entry.payload.netVotes === "number" && (
                  <span
                    className="px-1.5 py-0.5 rounded font-mono"
                    style={{
                      background:
                        (entry.payload.netVotes as number) > 0
                          ? "rgba(34,197,94,0.10)"
                          : (entry.payload.netVotes as number) < 0
                            ? "rgba(239,68,68,0.10)"
                            : "var(--panel-input-bg)",
                      color:
                        (entry.payload.netVotes as number) > 0
                          ? "#22c55e"
                          : (entry.payload.netVotes as number) < 0
                            ? "#ef4444"
                            : undefined,
                    }}
                  >
                    {(entry.payload.netVotes as number) > 0 ? "+" : ""}
                    {entry.payload.netVotes as number}
                    {" "}({entry.payload.confirmCount as number}/{entry.payload.disputeCount as number})
                  </span>
                )}
                {typeof entry.payload.lat === "number" && typeof entry.payload.lng === "number" && (
                  <a
                    href={`https://www.google.com/maps?q=${entry.payload.lat},${entry.payload.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono hover:underline"
                  >
                    {(entry.payload.lat as number).toFixed(4)}, {(entry.payload.lng as number).toFixed(4)}
                  </a>
                )}
                {typeof entry.payload.ageAtDeleteMs === "number" && (
                  <span className="font-mono">
                    age: {fmtAgo(Date.now() - (entry.payload.ageAtDeleteMs as number))}
                  </span>
                )}
                {typeof entry.payload.ownerName === "string" && (
                  <span>by {entry.payload.ownerName as string}</span>
                )}
              </div>
            )}
            <div
              className="mt-1 flex items-center gap-3 text-[10px] font-mono flex-wrap"
              style={{ color: "var(--panel-text-muted)" }}
            >
              <span>target: {entry.targetId.slice(0, 16)}…</span>
              <span>actor: {entry.actorUid.slice(0, 8)}…</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Broadcast tab ────────────────────────────────────────────────────

/** Title/body lengths matching the backend caps so the user can't
 *  compose something that gets silently truncated by the API. */
const BROADCAST_TITLE_MAX = 80;
const BROADCAST_BODY_MAX = 240;

/** Two-step composer: edit → confirm with recipient count. The
 *  confirmation step is non-negotiable for a city-wide push since
 *  the audience can't be recalled — once webpush hands the payload
 *  to the push service we can't yank it back. */
function BroadcastTab() {
  const { user } = useAuth();
  const currentCity = useMemo(() => getCurrentCity(), []);

  const [city, setCity] = useState<string | "all">(currentCity.slug);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [requireInteraction, setRequireInteraction] = useState(false);

  const [recipients, setRecipients] = useState<number | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    sent: number;
    matched: number;
    failed: number;
    skipped: number;
  } | null>(null);

  // Live preview the recipient count whenever the city selector
  // changes; debounced lightly so flipping the dropdown doesn't
  // hammer the backend on every keystroke / arrow-key press.
  useEffect(() => {
    let cancelled = false;
    setLoadingPreview(true);
    setRecipients(null);
    const t = window.setTimeout(async () => {
      const targetCity = city === "all" ? null : city;
      try {
        const n = await previewBroadcastRecipients(targetCity);
        if (!cancelled) setRecipients(n);
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [city]);

  const titleTrim = title.trim();
  const bodyTrim = body.trim();
  const canCompose = titleTrim.length > 0 && bodyTrim.length > 0;

  const onSend = async () => {
    if (!user || !canCompose) return;
    setSending(true);
    setError(null);
    setLastResult(null);
    const targetCity = city === "all" ? null : city;
    try {
      const result = await sendBroadcast({
        city: targetCity,
        title: titleTrim,
        body: bodyTrim,
        url: url.trim() || null,
        requireInteraction,
      });
      setLastResult({
        sent: result.sent,
        matched: result.matched,
        failed: result.failed,
        skipped: result.skipped,
      });
      try {
        await auditPushBroadcast(
          {
            city: targetCity,
            title: titleTrim,
            body: bodyTrim,
            url: url.trim() || null,
            requireInteraction,
            matched: result.matched,
            sent: result.sent,
            failed: result.failed,
            skipped: result.skipped,
            serverTag: result.tag ?? null,
          },
          {
            uid: user.uid,
            email: user.email ?? null,
            displayName: user.displayName ?? null,
          }
        );
      } catch (auditErr) {
        // Broadcast went out, audit failed — surface the error so
        // the admin can investigate without us silently losing the
        // record. The recipient count UI still updates.
        setError(auditErr instanceof Error ? auditErr.message : String(auditErr));
      }
      setConfirming(false);
      // Clear the composer on success so the next broadcast starts
      // from a blank slate; the toast-style result panel below stays
      // visible until the next compose action.
      setTitle("");
      setBody("");
      setUrl("");
      setRequireInteraction(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 space-y-3 max-w-xl mx-auto">
      <div
        className="p-3 rounded-lg border"
        style={{
          background: "rgba(168,85,247,0.08)",
          borderColor: "rgba(168,85,247,0.30)",
        }}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <Megaphone className="w-4 h-4 text-purple-400" />
          <span className="text-sm font-semibold" style={{ color: "var(--panel-text)" }}>
            Send a city-wide push
          </span>
        </div>
        <p className="text-[11px]" style={{ color: "var(--panel-text-secondary)" }}>
          This goes out to every Web Push subscriber in the selected
          city. Use it for genuine emergencies (shelter-in-place,
          severe weather, area-wide hazard) or critical product
          announcements — not for marketing or weekly digests. Every
          broadcast is recorded in the audit log with delivery counts.
        </p>
      </div>

      <div className="space-y-2">
        <div>
          <label
            className="block text-[11px] font-medium mb-1"
            style={{ color: "var(--panel-text-secondary)" }}
          >
            City
          </label>
          <select
            value={city}
            onChange={(e) => setCity(e.target.value as string | "all")}
            className="w-full px-2 py-1.5 rounded-md text-xs"
            style={{
              background: "var(--panel-input-bg)",
              color: "var(--panel-text)",
              border: "1px solid var(--panel-border)",
            }}
          >
            {PULSE_CITIES.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name} ({c.slug})
              </option>
            ))}
            <option value="all">All cities (use sparingly)</option>
          </select>
          <p className="mt-1 text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
            {loadingPreview ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                Counting subscribers…
              </span>
            ) : recipients === null ? (
              "—"
            ) : (
              <>{recipients.toLocaleString()} subscribed device{recipients === 1 ? "" : "s"} match this city.</>
            )}
          </p>
        </div>

        <div>
          <label
            className="block text-[11px] font-medium mb-1"
            style={{ color: "var(--panel-text-secondary)" }}
          >
            Title <span style={{ color: "var(--panel-text-muted)" }}>({title.length}/{BROADCAST_TITLE_MAX})</span>
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, BROADCAST_TITLE_MAX))}
            placeholder="e.g. Severe weather warning"
            className="w-full px-2 py-1.5 rounded-md text-xs"
            style={{
              background: "var(--panel-input-bg)",
              color: "var(--panel-text)",
              border: "1px solid var(--panel-border)",
            }}
          />
        </div>

        <div>
          <label
            className="block text-[11px] font-medium mb-1"
            style={{ color: "var(--panel-text-secondary)" }}
          >
            Body <span style={{ color: "var(--panel-text-muted)" }}>({body.length}/{BROADCAST_BODY_MAX})</span>
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, BROADCAST_BODY_MAX))}
            rows={4}
            placeholder="What's happening, and what should the user do?"
            className="w-full px-2 py-1.5 rounded-md text-xs resize-none"
            style={{
              background: "var(--panel-input-bg)",
              color: "var(--panel-text)",
              border: "1px solid var(--panel-border)",
            }}
          />
        </div>

        <div>
          <label
            className="block text-[11px] font-medium mb-1"
            style={{ color: "var(--panel-text-secondary)" }}
          >
            Tap-to-open URL <span style={{ color: "var(--panel-text-muted)" }}>(optional)</span>
          </label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="/transparency  ·  /?incident=…  ·  https://example.org/info"
            className="w-full px-2 py-1.5 rounded-md text-xs"
            style={{
              background: "var(--panel-input-bg)",
              color: "var(--panel-text)",
              border: "1px solid var(--panel-border)",
            }}
          />
          <p className="mt-1 text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
            Defaults to the map. Same-origin links open in the existing
            tab if one's open.
          </p>
        </div>

        <label className="flex items-center gap-2 text-[11px]" style={{ color: "var(--panel-text-secondary)" }}>
          <input
            type="checkbox"
            checked={requireInteraction}
            onChange={(e) => setRequireInteraction(e.target.checked)}
          />
          Require interaction (notification stays visible until tapped)
        </label>
      </div>

      {error && (
        <div
          className="p-2 rounded text-[11px] flex items-start gap-1.5"
          style={{
            background: "rgba(239,68,68,0.10)",
            color: "#fca5a5",
            border: "1px solid rgba(239,68,68,0.30)",
          }}
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {lastResult && !confirming && (
        <div
          className="p-2 rounded text-[11px]"
          style={{
            background: "rgba(34,197,94,0.10)",
            color: "#86efac",
            border: "1px solid rgba(34,197,94,0.30)",
          }}
        >
          Broadcast delivered to {lastResult.sent.toLocaleString()} of{" "}
          {lastResult.matched.toLocaleString()} devices
          {lastResult.failed > 0 && <> · {lastResult.failed} failed</>}
          {lastResult.skipped > 0 && <> · {lastResult.skipped} respected user prefs (snooze / quiet hours)</>}.
        </div>
      )}

      {!confirming ? (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setLastResult(null);
            setConfirming(true);
          }}
          disabled={!canCompose}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium disabled:opacity-50"
          style={{
            background: canCompose ? "rgba(168,85,247,0.20)" : "var(--panel-input-bg)",
            color: canCompose ? "#c084fc" : "var(--panel-text-muted)",
            border: `1px solid ${canCompose ? "rgba(168,85,247,0.40)" : "var(--panel-border)"}`,
          }}
        >
          <Send className="w-3 h-3" />
          Review broadcast
        </button>
      ) : (
        <div
          className="p-3 rounded-lg space-y-2"
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.30)",
          }}
        >
          <p className="text-[11px] font-medium" style={{ color: "#fca5a5" }}>
            About to push to {(recipients ?? 0).toLocaleString()} device
            {recipients === 1 ? "" : "s"} ({city === "all" ? "all cities" : city}). Confirm to send.
          </p>
          <div
            className="p-2 rounded"
            style={{
              background: "var(--panel-bg)",
              border: "1px solid var(--panel-border)",
            }}
          >
            <p className="text-xs font-semibold" style={{ color: "var(--panel-text)" }}>{titleTrim}</p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--panel-text-secondary)" }}>{bodyTrim}</p>
            {url.trim() && (
              <p className="text-[10px] mt-1 font-mono" style={{ color: "var(--panel-text-muted)" }}>
                → {url.trim()}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={sending}
              className="flex-1 px-3 py-1.5 rounded-md text-xs disabled:opacity-50"
              style={{
                background: "var(--panel-input-bg)",
                color: "var(--panel-text-secondary)",
                border: "1px solid var(--panel-border)",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSend}
              disabled={sending || !canCompose}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium disabled:opacity-50"
              style={{
                background: "rgba(239,68,68,0.20)",
                color: "#f87171",
                border: "1px solid rgba(239,68,68,0.40)",
              }}
            >
              {sending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Send className="w-3 h-3" />
              )}
              {sending ? "Sending…" : "Send broadcast"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
