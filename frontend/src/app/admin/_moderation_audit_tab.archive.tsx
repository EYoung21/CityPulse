"use client";

/**
 * ARCHIVED — 2026-04
 *
 * Previously the second tab inside `ModerationPanel` ("Audit log").
 * Product change: the live moderation surface only shows user report
 * intake. Drop this file back into `ModerationPanel.tsx` (restore the
 * tab strip + import `ArchivedModerationAuditTab`) if the audit ledger
 * should ship to admins again.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  describeAuditAction,
  subscribeModerationAudit,
  type ModerationAuditEntry,
} from "@/lib/moderation-audit";

function fmtAgo(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

export function ArchivedModerationAuditTab() {
  const [rows, setRows] = useState<ModerationAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<"all" | ModerationAuditEntry["kind"]>("all");

  useEffect(() => {
    const loadingTimer = window.setTimeout(() => setLoading(true), 0);
    const unsub = subscribeModerationAudit(
      kindFilter === "all" ? {} : { kind: kindFilter },
      (data) => {
        window.clearTimeout(loadingTimer);
        setRows(data);
        setLoading(false);
        setError(null);
      },
      (err) => {
        window.clearTimeout(loadingTimer);
        setError(err.message);
        setLoading(false);
      }
    );
    return () => {
      window.clearTimeout(loadingTimer);
      unsub();
    };
  }, [kindFilter]);

  const KINDS: { value: "all" | ModerationAuditEntry["kind"]; label: string; color: string }[] = [
    { value: "all", label: "All", color: "#a855f7" },
    { value: "feedback.delete", label: "Feedback deletes", color: "#ef4444" },
    { value: "feedback.status", label: "Status changes", color: "#3b82f6" },
  ];

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
        <span style={{ color: "rgba(255,255,255,0.5)" }}>Filter:</span>
        {KINDS.map((k) => {
          const active = kindFilter === k.value;
          return (
            <button
              key={k.value}
              type="button"
              onClick={() => setKindFilter(k.value)}
              className="px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors"
              style={{
                background: active ? `${k.color}22` : "rgba(255,255,255,0.04)",
                color: active ? k.color : "rgba(255,255,255,0.7)",
                border: `1px solid ${active ? `${k.color}55` : "rgba(255,255,255,0.06)"}`,
              }}
            >
              {k.label}
            </button>
          );
        })}
        <span className="ml-auto" style={{ color: "rgba(255,255,255,0.5)" }}>
          {rows.length} entr{rows.length === 1 ? "y" : "ies"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div
            className="flex items-center justify-center gap-2 py-12 text-xs"
            style={{ color: "rgba(255,255,255,0.5)" }}
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
          <div className="text-center py-12 text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>
            No audit entries yet. Moderation actions you take will appear here.
          </div>
        )}
        {rows.map((entry) => (
          <div key={entry.id} className="px-4 py-2.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
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
              <span style={{ color: "#fff" }} className="font-medium">
                {entry.actorDisplayName || entry.actorEmail || entry.actorUid.slice(0, 8) + "…"}
              </span>
              <span style={{ color: "rgba(255,255,255,0.5)" }} title={new Date(entry.createdAtMs).toString()}>
                · {fmtAgo(entry.createdAtMs)}
              </span>
            </div>
            {entry.targetSnippet && (
              <p className="mt-1 text-[12px] leading-snug whitespace-pre-wrap" style={{ color: "rgba(255,255,255,0.7)" }}>
                &ldquo;{entry.targetSnippet}&rdquo;
              </p>
            )}
            <div className="mt-1 flex items-center gap-3 text-[10px] font-mono flex-wrap" style={{ color: "rgba(255,255,255,0.5)" }}>
              <span>target: {entry.targetId.slice(0, 16)}…</span>
              <span>actor: {entry.actorUid.slice(0, 8)}…</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
