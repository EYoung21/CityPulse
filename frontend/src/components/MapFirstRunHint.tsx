"use client";

/** Subtle first-run hint chip.
 *
 *  Replaces the old auto-popping "Quick map tour" modal, which blocked
 *  the map on first load — the opposite of "go right to the map". This
 *  is a small, non-blocking pill (the map stays fully interactive
 *  underneath): a one-liner pointing at the two least-obvious gestures,
 *  plus a "Quick tour" button that opens the full walkthrough on demand
 *  (fires `pp:show-gestures-tour`, which MapGesturesTour listens for).
 *
 *  Shows once per browser (localStorage-gated), a beat after the map
 *  settles, and auto-dismisses so it never lingers. Pointer-aware
 *  wording: "tap / long-press" on touch, "click / right-click" on
 *  desktop. */

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, X as XIcon } from "lucide-react";

const SEEN_KEY = "pp:map-hint-seen-v1";
const AUTO_DISMISS_MS = 14000;

export default function MapFirstRunHint() {
  const [visible, setVisible] = useState(false);
  // Pointer mode, picked once at mount (SSR-guarded) so the wording
  // reads "tap / long-press" on touch and "click / right-click" on
  // desktop. A lazy initializer avoids a setState-in-effect cascade.
  const [coarse] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.matchMedia?.("(pointer: coarse)").matches ?? false;
    } catch {
      return false;
    }
  });

  // Decide once on mount whether to show. Delay a touch so the initial
  // map paint (and any auth spinner) settles before the chip slides in.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let seen = false;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      /* private mode — treat as unseen */
    }
    if (seen) return;
    const id = window.setTimeout(() => setVisible(true), 1500);
    return () => window.clearTimeout(id);
  }, []);

  // Auto-dismiss so a first-run hint never becomes permanent clutter.
  useEffect(() => {
    if (!visible) return;
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(SEEN_KEY, "1");
      } catch {
        /* ignore */
      }
      setVisible(false);
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [visible]);

  const markSeen = () => {
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  const dismiss = () => {
    markSeen();
    setVisible(false);
  };

  const startTour = () => {
    markSeen();
    setVisible(false);
    window.dispatchEvent(new CustomEvent("pp:show-gestures-tour"));
  };

  const tap = coarse ? "Tap" : "Click";
  const hold = coarse ? "long-press" : "right-click";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="pointer-events-none fixed left-1/2 z-[var(--pp-z-toast)] flex -translate-x-1/2 justify-center px-3"
          style={{
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 7.5rem)",
            maxWidth: "min(94vw, 30rem)",
          }}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.22 }}
          role="status"
        >
          <div
            className="pointer-events-auto flex items-center gap-2.5 rounded-full py-2 pl-3.5 pr-2 shadow-2xl backdrop-blur-xl"
            style={{ background: "var(--panel-bg)", border: "1px solid var(--panel-border)" }}
          >
            <Sparkles className="h-4 w-4 shrink-0" style={{ color: "#a855f7" }} aria-hidden="true" />
            <p className="text-xs leading-snug" style={{ color: "var(--panel-text)" }}>
              {tap} a hotspot for details, {hold} for live activity.
            </p>
            <button
              type="button"
              onClick={startTour}
              className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition-colors"
              style={{ background: "#3b82f6", color: "white" }}
            >
              Quick tour
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="shrink-0 rounded-full p-1 transition-colors hover:bg-white/5"
              style={{ color: "var(--panel-text-muted)" }}
              aria-label="Dismiss hint"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
