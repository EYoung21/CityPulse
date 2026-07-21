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
 *    - Opt-in only. It does NOT auto-pop on first load — a blocking
 *      modal over the map is the opposite of "go right to the map".
 *      The subtle first-run hint chip (MapFirstRunHint) offers a
 *      "Quick tour" button, and the keyboard cheat sheet offers
 *      another entry point; both fire `pp:show-gestures-tour`.
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
  Search,
  ChevronLeft,
  ChevronRight,
  X as XIcon,
  Sparkles,
  MapPinned,
  Navigation,
  SlidersHorizontal,
} from "lucide-react";

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
    icon: Search,
    title: "Search where you're headed",
    bodyTouch:
      "Search an address, intersection, or place. CityPulse checks recent incidents around the route before you go.",
    bodyMouse:
      "Search an address, intersection, or place. CityPulse checks recent incidents around the route before you go.",
    accent: "#22c55e",
  },
  {
    icon: Navigation,
    title: "Choose the safer route",
    bodyTouch:
      "Tap Get Safe Directions to compare routes. Safer route options steer around reported incidents, crashes, and traffic.",
    bodyMouse:
      "Open Directions to compare routes. Safer route options steer around reported incidents, crashes, and traffic.",
    accent: "#a855f7",
  },
  {
    icon: SlidersHorizontal,
    title: "Tune what you avoid",
    bodyTouch:
      "Use the five simple toggles for violent, fire, medical, traffic, and disorder reports. Advanced controls are still one tap away.",
    bodyMouse:
      "Use the five simple toggles for violent, fire, medical, traffic, and disorder reports. Advanced controls are still one tap away.",
    accent: "#f59e0b",
  },
  {
    icon: MapPinned,
    title: "Read the map as you move",
    bodyTouch:
      "Tap a cluster for details, or long-press the map to see live activity near a block before you walk or drive through it.",
    bodyMouse:
      "Click a cluster for details, or right-click the map to see live activity near a block before you walk or drive through it.",
    accent: "#ec4899",
  },
];

function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
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

  // Opt-in only — the tour opens when the user asks for it (the
  // first-run hint chip's "Quick tour" button, the keyboard cheat
  // sheet, etc.), all of which fire `pp:show-gestures-tour`. It no
  // longer auto-pops on first load.
  useEffect(() => {
    const onShow = () => { setStep(0); setOpen(true); };
    window.addEventListener("pp:show-gestures-tour", onShow);
    return () => window.removeEventListener("pp:show-gestures-tour", onShow);
  }, []);

  const close = () => setOpen(false);

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
          className="fixed inset-0 z-[var(--pp-z-mobile-menu)] flex items-end sm:items-center justify-center px-2 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] sm:p-4"
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
            className="relative flex w-full flex-col overflow-hidden rounded-2xl shadow-2xl sm:max-w-md"
            style={{
              background: "var(--panel-bg)",
              border: "1px solid var(--panel-border)",
              maxHeight: "calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 1.5rem)",
            }}
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

            <div className="min-h-0 overflow-y-auto px-5 pt-5 pb-4 flex flex-col items-center text-center">
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
