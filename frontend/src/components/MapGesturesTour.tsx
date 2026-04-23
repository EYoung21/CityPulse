"use client";

/** First-run interactive walkthrough of map gestures.
 *
 *  Why ship this:
 *    The map supports a half-dozen non-obvious gestures (single-tap
 *    for a Safety Score Card, long-press for a live-activity peek,
 *    two-finger pinch to zoom, etc.) that users would otherwise
 *    discover by accident — or never. A short, skippable tour up
 *    front cuts the "how do I…" floor.
 *
 *  Behaviour:
 *    - Auto-opens once on first visit (gated by a localStorage flag
 *      written when the tour completes OR the user explicitly skips).
 *    - Re-openable any time via a `pp:show-gestures-tour` window
 *      event (fired from the keyboard-shortcuts cheat sheet) so the
 *      user can refresh their memory.
 *    - Each step has an icon + headline + a short caption. Steps are
 *      ordered roughly by frequency-of-use (single tap first).
 *    - Auto-detects coarse pointer (touch) vs fine pointer (mouse) so
 *      the captions read "tap" / "long-press" on phones and "click" /
 *      "right-click" on desktops without forking the steps.
 *    - Honours `prefers-reduced-motion`: framer-motion's reduced-
 *      motion provider already does this for our transitions; here
 *      we just keep the default animation values short and gentle. */

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MousePointerClick,
  Hand,
  ZoomIn,
  Compass,
  Search,
  ChevronLeft,
  ChevronRight,
  X as XIcon,
  Sparkles,
} from "lucide-react";

const SEEN_KEY = "pp:gestures-tour-seen-v1";

interface Step {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  /** Provide both phrasings — the renderer picks based on input mode. */
  bodyTouch: string;
  bodyMouse: string;
  /** Optional accent colour for the icon halo. */
  accent: string;
}

const STEPS: Step[] = [
  {
    icon: MousePointerClick,
    title: "Tap the map for a safety read",
    bodyTouch:
      "Tap any spot on the map and we'll pop up a Safety Score Card with recent incident counts and a colour-coded risk level for that block.",
    bodyMouse:
      "Click any spot on the map and we'll pop up a Safety Score Card with recent incident counts and a colour-coded risk level for that block.",
    accent: "#22c55e",
  },
  {
    icon: Hand,
    title: "Long-press for live activity",
    bodyTouch:
      "Press and hold anywhere to peek at what's happening right now: a quick read of incidents reported in the last hour within a block or so. Read-only, dismisses with a tap.",
    bodyMouse:
      "Right-click (or hold the mouse down for half a second) to peek at what's happening right now: a quick read of incidents reported in the last hour within a block or so. Read-only, dismisses with a click.",
    accent: "#a855f7",
  },
  {
    icon: ZoomIn,
    title: "Pinch and double-tap to zoom",
    bodyTouch:
      "Pinch in or out with two fingers, or double-tap to zoom in. Hold a finger down and drag up/down to zoom continuously.",
    bodyMouse:
      "Scroll the wheel to zoom, or double-click to zoom in. Hold Shift and drag a box to zoom into a region.",
    accent: "#3b82f6",
  },
  {
    icon: Compass,
    title: "Two-finger drag to rotate",
    bodyTouch:
      "Use two fingers to twist the map. Tap the compass in the corner any time to snap back to north-up.",
    bodyMouse:
      "Hold Alt and drag with the right mouse button to rotate the map. Tap the compass to snap back to north-up.",
    accent: "#f59e0b",
  },
  {
    icon: Search,
    title: "Search anything in Philly",
    bodyTouch:
      "Tap the search bar to look up an address, intersection, or business, or hit the mic for hands-free voice search.",
    bodyMouse:
      "Press / or Cmd/Ctrl+K to jump to the search box. Type an address, intersection, or business, or use the mic for voice search.",
    accent: "#ec4899",
  },
];

function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    setCoarse(mq.matches);
    const handler = (e: MediaQueryListEvent) => setCoarse(e.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);
  return coarse;
}

export default function MapGesturesTour() {
  const coarse = useIsCoarsePointer();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  // Auto-open on first visit. We deliberately delay by ~1.2s so the
  // initial map render and any onboarding spinners settle first —
  // popping a modal *during* the first paint feels jarring.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let seen = false;
    try { seen = window.localStorage.getItem(SEEN_KEY) === "1"; } catch { /* private mode — treat as unseen */ }
    if (seen) return;
    const id = window.setTimeout(() => setOpen(true), 1200);
    return () => window.clearTimeout(id);
  }, []);

  // Allow other surfaces (keyboard help cheat sheet, alerts inbox)
  // to re-open the tour on demand.
  useEffect(() => {
    const onShow = () => { setStep(0); setOpen(true); };
    window.addEventListener("pp:show-gestures-tour", onShow);
    return () => window.removeEventListener("pp:show-gestures-tour", onShow);
  }, []);

  const markSeen = () => {
    try { window.localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
  };

  const close = () => {
    markSeen();
    setOpen(false);
  };

  const next = () => {
    if (step >= STEPS.length - 1) {
      close();
      return;
    }
    setStep((s) => s + 1);
  };

  const prev = () => {
    if (step <= 0) return;
    setStep((s) => s - 1);
  };

  const current = STEPS[step];
  const body = useMemo(() => (coarse ? current.bodyTouch : current.bodyMouse), [coarse, current]);

  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="gestures-tour"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[1100] flex items-end sm:items-center justify-center"
          // Backdrop click → close. Stop propagation in the inner card.
          onClick={close}
        >
          <div
            className="absolute inset-0"
            style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }}
          />
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="relative w-full sm:max-w-md mx-2 mb-4 sm:mb-0 rounded-2xl shadow-2xl overflow-hidden"
            style={{ background: "var(--panel-bg)", border: "1px solid var(--panel-border)" }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="gestures-tour-title"
          >
            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderBottom: "1px solid var(--panel-border)" }}
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4" style={{ color: "#a855f7" }} aria-hidden="true" />
                <span className="text-xs font-medium" style={{ color: "var(--panel-text-muted)" }}>
                  Quick map tour · {step + 1} of {STEPS.length}
                </span>
              </div>
              <button
                type="button"
                onClick={close}
                className="p-1 rounded-md transition-colors hover:bg-white/5"
                style={{ color: "var(--panel-text-muted)" }}
                aria-label="Close tour"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 pt-5 pb-4 flex flex-col items-center text-center">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3"
                style={{
                  background: `${current.accent}1f`,
                  border: `1px solid ${current.accent}55`,
                  color: current.accent,
                }}
              >
                <current.icon className="w-7 h-7" />
              </div>
              <h2
                id="gestures-tour-title"
                className="text-base font-semibold mb-1.5"
                style={{ color: "var(--panel-text)" }}
              >
                {current.title}
              </h2>
              <p className="text-xs leading-relaxed" style={{ color: "var(--panel-text-muted)" }}>
                {body}
              </p>
            </div>

            <div className="flex items-center justify-center gap-1.5 pb-3">
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  aria-hidden="true"
                  className="rounded-full transition-all"
                  style={{
                    width: i === step ? 18 : 6,
                    height: 6,
                    background: i === step ? "var(--panel-text)" : "var(--panel-text-muted)",
                    opacity: i === step ? 0.95 : 0.35,
                  }}
                />
              ))}
            </div>

            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderTop: "1px solid var(--panel-border)" }}
            >
              <button
                type="button"
                onClick={prev}
                disabled={step === 0}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40"
                style={{ color: "var(--panel-text-muted)" }}
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Back
              </button>
              <button
                type="button"
                onClick={close}
                className="text-xs underline-offset-2 hover:underline"
                style={{ color: "var(--panel-text-muted)" }}
              >
                Skip
              </button>
              <button
                type="button"
                onClick={next}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors"
                style={{ background: "#3b82f6", color: "white" }}
              >
                {step >= STEPS.length - 1 ? "Got it" : "Next"}{" "}
                {step < STEPS.length - 1 && <ChevronRight className="w-3.5 h-3.5" />}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
