"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { RotateCcw, X } from "lucide-react";
import {
  __undoInternals,
  subscribeUndoToast,
} from "@/lib/undo-toast";

interface VisibleToast {
  id: string;
  label: string;
  detail?: string;
  startedAt: number;
  timeoutMs: number;
}

/** Single floating toast at the bottom-center showing the most recent
 *  pending undoable action. Animates in/out with framer and renders a
 *  thin progress bar so users can see how long they have left to undo.
 *
 *  Mounted once at the page root; subscribes to the global undo-toast
 *  module so any callsite can fire `requestUndoableAction()` without
 *  caring whether a host is mounted yet — late mounts replay current
 *  state via the subscribe callback. */
export default function UndoToastHost() {
  const [toast, setToast] = useState<VisibleToast | null>(null);
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    return subscribeUndoToast((t) => {
      if (!t) {
        setToast(null);
        return;
      }
      setToast({
        id: t.id,
        label: t.label,
        detail: t.detail,
        startedAt: t.startedAt,
        timeoutMs: t.timeoutMs ?? 5000,
      });
      setProgress(1);
    });
  }, []);

  // Animate the countdown bar smoothly. We re-tick at 60Hz via rAF
  // rather than setInterval(16) so the bar stays in sync with the
  // refresh and burns no battery when the tab is hidden.
  useEffect(() => {
    if (!toast) return;
    let raf = 0;
    const tick = () => {
      const remaining = toast.startedAt + toast.timeoutMs - Date.now();
      const p = Math.max(0, remaining / toast.timeoutMs);
      setProgress(p);
      if (p > 0) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [toast]);

  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          key={toast.id}
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          transition={{ type: "spring", stiffness: 360, damping: 30 }}
          // Above the parked-pin pill (1090) so a freshly-deleted
          // parked pin's "Undo" toast sits visually above the
          // (still possibly visible) confirmation row.
          className="fixed inset-x-0 z-[1110] flex justify-center px-3 pointer-events-none"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }}
          role="status"
          aria-live="polite"
        >
          <div
            className="pointer-events-auto w-full max-w-md rounded-xl shadow-2xl backdrop-blur-xl overflow-hidden"
            style={{
              background: "rgba(15, 23, 42, 0.95)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "#fff",
            }}
          >
            <div className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{toast.label}</p>
                {toast.detail && (
                  <p className="text-[11px] text-slate-400 truncate">{toast.detail}</p>
                )}
              </div>
              <button
                type="button"
                onClick={__undoInternals.undo}
                className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Undo
              </button>
              <button
                type="button"
                onClick={__undoInternals.commit}
                className="shrink-0 p-1 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors"
                aria-label="Dismiss"
                title="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {/* Countdown bar — visual cue for how long the user has
                left to undo. */}
            <div className="h-0.5 bg-white/5">
              <div
                className="h-full bg-blue-400/80 transition-none"
                style={{ width: `${(progress * 100).toFixed(2)}%` }}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
