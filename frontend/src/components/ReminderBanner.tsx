"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, Clock, Navigation, X } from "lucide-react";
import type { TripReminderPayload } from "@/lib/scheduled-reminders";

const AUTO_DISMISS_MS = 14_000;

/** Small floating banner triggered by `pp:trip-reminder` events from
 *  ReminderRunner. Auto-dismisses after 14s but offers two persistent
 *  CTAs: "Plan now" (re-opens the directions sidebar with the saved
 *  destination preselected) and "Snooze 5m" (re-arms via a one-shot
 *  setTimeout — we deliberately don't re-write storage so a snooze
 *  doesn't survive a refresh, matching how OS-level snoozes work). */
export default function ReminderBanner() {
  const [active, setActive] = useState<TripReminderPayload | null>(null);

  const dismiss = useCallback(() => setActive(null), []);

  useEffect(() => {
    const onEvt = (e: Event) => {
      const detail = (e as CustomEvent<TripReminderPayload>).detail;
      if (!detail || !detail.reminder) return;
      setActive(detail);
    };
    window.addEventListener("pp:trip-reminder", onEvt);
    return () => window.removeEventListener("pp:trip-reminder", onEvt);
  }, []);

  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => setActive(null), AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [active]);

  const planNow = useCallback(() => {
    if (!active) return;
    const r = active.reminder;
    try {
      window.dispatchEvent(
        new CustomEvent("pp:plan-route", {
          detail: { mode: "to", lat: r.destLat, lng: r.destLng, label: r.destLabel },
        })
      );
    } catch { /* ignore */ }
    dismiss();
  }, [active, dismiss]);

  const snooze = useCallback(() => {
    if (!active) return;
    const captured = active;
    dismiss();
    window.setTimeout(() => setActive(captured), 5 * 60_000);
  }, [active, dismiss]);

  if (!active) return null;
  const { reminder, missed } = active;
  const departLocal = new Date(reminder.departAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <AnimatePresence>
      <motion.div
        key={reminder.id}
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -16 }}
        transition={{ duration: 0.25 }}
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[1100] w-[min(28rem,calc(100vw-1.5rem))] rounded-2xl shadow-2xl backdrop-blur-xl"
        style={{
          background: "var(--panel-bg)",
          border: `1px solid ${missed ? "rgba(245,158,11,0.45)" : "rgba(59,130,246,0.45)"}`,
        }}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-3 p-3">
          <div
            className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center"
            style={{
              background: missed ? "rgba(245,158,11,0.15)" : "rgba(59,130,246,0.15)",
              color: missed ? "#f59e0b" : "#3b82f6",
            }}
          >
            {missed ? <Clock className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold" style={{ color: "var(--panel-text)" }}>
              {missed
                ? `Trip to ${reminder.destLabel}`
                : `Trip in ${reminder.leadMinutes} min`}
            </p>
            <p className="text-[11px] mt-0.5 leading-snug" style={{ color: "var(--panel-text-secondary)" }}>
              {missed
                ? `Was scheduled for ${departLocal}`
                : `${reminder.destLabel} · leave by ${departLocal}`}
            </p>
            <div className="flex items-center gap-1.5 mt-2">
              <button
                type="button"
                onClick={planNow}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors"
                style={{
                  background: "rgba(59,130,246,0.18)",
                  color: "#3b82f6",
                  border: "1px solid rgba(59,130,246,0.40)",
                }}
              >
                <Navigation className="w-3 h-3" />
                Plan now
              </button>
              {!missed && (
                <button
                  type="button"
                  onClick={snooze}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
                  style={{
                    color: "var(--panel-text-muted)",
                    border: "1px solid var(--panel-border)",
                  }}
                >
                  Snooze 5m
                </button>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="p-1 -m-1 shrink-0"
            style={{ color: "var(--panel-text-muted)" }}
            aria-label="Dismiss reminder"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
