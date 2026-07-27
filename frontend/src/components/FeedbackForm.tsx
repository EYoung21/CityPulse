"use client";

/** Modal feedback / bug-report form. Triggered from the About panel
 *  (and any other surface that wires up `pp:open-feedback`). Honours
 *  prefers-reduced-motion via framer-motion's gentle defaults. */

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquarePlus, Loader2, Check, AlertCircle, X as XIcon } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  FEEDBACK_KINDS,
  submitFeedback,
  type FeedbackKind,
} from "@/lib/feedback";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export default function FeedbackForm() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [pickedKind, setPickedKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Listen for global open events so any surface (about panel,
  // keyboard help, etc.) can trigger us with a one-liner. Keeping
  // the open state internal avoids prop-drilling through page.tsx.
  useEffect(() => {
    const onOpen = () => {
      setStatus({ kind: "idle" });
      setMessage("");
      setContactEmail("");
      setPickedKind("bug");
      setOpen(true);
    };
    window.addEventListener("pp:open-feedback", onOpen);
    return () => window.removeEventListener("pp:open-feedback", onOpen);
  }, []);

  // Esc-to-close mirrors the rest of the app's modal behaviour.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const handleSubmit = async () => {
    if (status.kind === "submitting") return;
    setStatus({ kind: "submitting" });
    try {
      await submitFeedback(
        {
          kind: pickedKind,
          message,
          contactEmail: contactEmail.trim() || undefined,
        },
        {
          uid: user?.uid ?? null,
          email: user?.email ?? null,
          displayName: user?.displayName ?? null,
          isAnonymous: user?.isAnonymous ?? true,
        }
      );
      setStatus({ kind: "ok" });
      // Auto-close shortly after the success state shows so the form
      // doesn't linger on top of the map.
      window.setTimeout(() => setOpen(false), 1600);
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Couldn't send feedback.",
      });
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="feedback-form"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[1100] flex items-end sm:items-center justify-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="absolute inset-0"
            style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }}
          />
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="relative w-full sm:max-w-md mx-2 mb-2 sm:mb-0 rounded-2xl shadow-2xl overflow-hidden"
            style={{ background: "var(--panel-bg)", border: "1px solid var(--panel-border)" }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-title"
          >
            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderBottom: "1px solid var(--panel-border)" }}
            >
              <div className="flex items-center gap-2">
                <MessageSquarePlus className="w-4 h-4" style={{ color: "#3b82f6" }} aria-hidden="true" />
                <h2
                  id="feedback-title"
                  className="text-sm font-semibold"
                  style={{ color: "var(--panel-text)" }}
                >
                  Send feedback
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded-md transition-colors hover:bg-white/5"
                style={{ color: "var(--panel-text-muted)" }}
                aria-label="Close feedback form"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--panel-text-muted)" }}>
                  Type
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {FEEDBACK_KINDS.map((k) => {
                    const selected = pickedKind === k.kind;
                    return (
                      <button
                        key={k.kind}
                        type="button"
                        onClick={() => setPickedKind(k.kind)}
                        disabled={status.kind === "submitting"}
                        title={k.hint}
                        className="px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors disabled:opacity-50"
                        style={{
                          background: selected ? "rgba(59,130,246,0.18)" : "var(--panel-input-bg)",
                          color: selected ? "#3b82f6" : "var(--panel-text)",
                          border: `1px solid ${selected ? "rgba(59,130,246,0.55)" : "var(--panel-input-border)"}`,
                        }}
                      >
                        {k.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--panel-text-muted)" }}>
                  What&apos;s on your mind?
                </p>
                <textarea
                  autoFocus
                  aria-label="Feedback details"
                  value={message}
                  onChange={(e) => setMessage(e.target.value.slice(0, 1000))}
                  rows={5}
                  placeholder={
                    pickedKind === "bug"
                      ? "What were you trying to do? What happened? What did you expect?"
                      : pickedKind === "feature"
                        ? "What's the feature, and what problem does it solve for you?"
                        : "Tell us anything…"
                  }
                  maxLength={1000}
                  disabled={status.kind === "submitting"}
                  className="w-full px-2.5 py-2 rounded-md text-xs resize-y focus:outline-none focus:ring-1"
                  style={{
                    background: "var(--panel-input-bg)",
                    color: "var(--panel-text)",
                    border: "1px solid var(--panel-input-border)",
                    minHeight: 100,
                  }}
                />
                <div className="text-[10px] mt-1 text-right" style={{ color: "var(--panel-text-muted)" }}>
                  {1000 - message.length} chars left
                </div>
              </div>

              {/* Show the contact-email field for everyone — signed-
                  in users may want a different reply address than
                  their account email; signed-out users need it to
                  receive any reply at all. Optional in both cases. */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--panel-text-muted)" }}>
                  Email (optional)
                </p>
                <input
                  type="email"
                  aria-label="Contact email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder={user?.email && !user.isAnonymous ? user.email : "you@example.com"}
                  maxLength={254}
                  disabled={status.kind === "submitting"}
                  className="w-full px-2.5 py-1.5 rounded-md text-xs focus:outline-none focus:ring-1"
                  style={{
                    background: "var(--panel-input-bg)",
                    color: "var(--panel-text)",
                    border: "1px solid var(--panel-input-border)",
                  }}
                />
                {user && !user.isAnonymous && (
                  <p className="text-[10px] mt-1" style={{ color: "var(--panel-text-muted)" }}>
                    We already see your account email; only fill this in to use a different one.
                  </p>
                )}
              </div>

              {status.kind === "error" && (
                <p
                  className="flex items-start gap-1 text-[11px] leading-snug rounded-md px-2 py-1.5"
                  style={{
                    color: "#ef4444",
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.30)",
                  }}
                >
                  <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                  {status.message}
                </p>
              )}

              {status.kind === "ok" && (
                <p
                  className="flex items-center gap-1.5 text-[11px] rounded-md px-2 py-1.5"
                  style={{
                    color: "#22c55e",
                    background: "rgba(34,197,94,0.08)",
                    border: "1px solid rgba(34,197,94,0.30)",
                  }}
                >
                  <Check className="w-3.5 h-3.5" />
                  Thanks — we read every message.
                </p>
              )}

              <div className="flex items-center justify-between gap-2 pt-1">
                <p className="text-[10px] leading-snug" style={{ color: "var(--panel-text-muted)" }}>
                  We attach app version, browser, and viewport size to help with triage. No location data.
                </p>
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={status.kind === "submitting" || message.trim().length === 0}
                  className="shrink-0 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold transition-colors disabled:opacity-50"
                  style={{ background: "#3b82f6", color: "white" }}
                >
                  {status.kind === "submitting" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <MessageSquarePlus className="w-3.5 h-3.5" />
                  )}
                  {status.kind === "submitting" ? "Sending…" : "Send"}
                </button>
              </div>

              {/* Email escape hatch — if sign-in or Firebase itself is the
                  thing that's broken, the form above can't get through.
                  A plain mailto always works. */}
              <p
                className="text-[10px] leading-snug text-center pt-1"
                style={{ color: "var(--panel-text-muted)" }}
              >
                Form acting up? Email{" "}
                <a
                  href="mailto:eliyoung4now@gmail.com?subject=CityPulse%20feedback"
                  className="underline"
                  style={{ color: "var(--panel-text)" }}
                >
                  eliyoung4now@gmail.com
                </a>{" "}
                directly.
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
