"use client";

/** Inline crowdsourced-report form, embedded in DroppedPinCard.
 *
 *  Two-step flow:
 *    1. User picks a category from a row of glyph pills.
 *    2. Optional note (≤140 chars) + Submit / Cancel.
 *
 *  Anonymous users see a "Sign in to report" hint instead of the
 *  category picker — Firestore rules reject anonymous writes anyway,
 *  so failing fast with a friendly message is better than letting
 *  the round-trip fail. */

import { useState } from "react";
import { Megaphone, Loader2, Check, AlertCircle, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  USER_REPORT_CATEGORIES,
  submitUserReport,
  type UserReportCategory,
} from "@/lib/user-reports";

interface Props {
  lat: number;
  lng: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export default function ReportPinForm({ lat, lng }: Props) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<UserReportCategory | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const isSignedIn = !!user && !user.isAnonymous;

  const submit = async () => {
    if (!picked || !user) return;
    setStatus({ kind: "submitting" });
    try {
      await submitUserReport(
        { lat, lng, category: picked, note: note.trim() || undefined },
        {
          uid: user.uid,
          isAnonymous: user.isAnonymous,
          displayName: user.displayName,
          email: user.email,
        }
      );
      setStatus({ kind: "ok" });
      // Briefly show the success state before collapsing the form so
      // the user gets confirmation, then auto-reset for the next pin.
      window.setTimeout(() => {
        setStatus({ kind: "idle" });
        setOpen(false);
        setPicked(null);
        setNote("");
      }, 1400);
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Couldn't submit report.",
      });
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
        style={{
          background: "rgba(168,85,247,0.10)",
          color: "#a855f7",
          border: "1px solid rgba(168,85,247,0.30)",
        }}
        title="Drop a crowdsourced report visible to other PhillyPulse users for ~4 hours"
      >
        <Megaphone className="w-4 h-4" /> Report what you see
      </button>
    );
  }

  return (
    <div
      className="rounded-lg p-2.5 space-y-2"
      style={{
        background: "rgba(168,85,247,0.06)",
        border: "1px solid rgba(168,85,247,0.25)",
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#a855f7" }}>
          Report what you see
        </span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setPicked(null);
            setNote("");
            setStatus({ kind: "idle" });
          }}
          className="p-0.5"
          style={{ color: "var(--panel-text-muted)" }}
          aria-label="Cancel report"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {!isSignedIn ? (
        <p className="text-[11px] leading-snug" style={{ color: "var(--panel-text-muted)" }}>
          Sign in with Google or email to drop a crowdsourced report. Anonymous sessions can read reports but can&apos;t submit.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {USER_REPORT_CATEGORIES.map((c) => {
              const selected = picked === c.severity;
              return (
                <button
                  key={c.severity}
                  type="button"
                  onClick={() => setPicked(c.severity)}
                  disabled={status.kind === "submitting"}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    background: selected ? "rgba(168,85,247,0.20)" : "var(--panel-input-bg)",
                    color: selected ? "#a855f7" : "var(--panel-text)",
                    border: `1px solid ${selected ? "rgba(168,85,247,0.55)" : "var(--panel-input-border)"}`,
                  }}
                  title={c.hint}
                >
                  <span aria-hidden="true">{c.glyph}</span>
                  {c.label}
                </button>
              );
            })}
          </div>

          {picked && (
            <div className="space-y-1.5">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 140))}
                placeholder="Add a short note (optional)…"
                maxLength={140}
                rows={2}
                className="w-full px-2 py-1.5 rounded-md text-xs resize-none focus:outline-none focus:ring-1"
                style={{
                  background: "var(--panel-input-bg)",
                  color: "var(--panel-text)",
                  border: "1px solid var(--panel-input-border)",
                }}
                disabled={status.kind === "submitting"}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
                  {140 - note.length} chars left · expires in 4h
                </span>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={status.kind === "submitting"}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors disabled:opacity-60"
                  style={{ background: "#a855f7", color: "white" }}
                >
                  {status.kind === "submitting" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : status.kind === "ok" ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <Megaphone className="w-3.5 h-3.5" />
                  )}
                  {status.kind === "submitting" ? "Posting…" : status.kind === "ok" ? "Posted" : "Post report"}
                </button>
              </div>
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
        </>
      )}
    </div>
  );
}
