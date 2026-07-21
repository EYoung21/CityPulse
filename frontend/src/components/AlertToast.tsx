"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Radio, X as XIcon } from "lucide-react";
import type { Incident } from "@/lib/api";
import { getSeverity } from "@/lib/severity";

interface Props {
  incidents: Incident[];
}

export default function AlertToast({ incidents }: Props) {
  const prevIdsRef = useRef<Set<string>>(new Set());
  const dismissTimerRef = useRef<number | null>(null);
  const [toast, setToast] = useState<Incident | null>(null);

  useEffect(() => {
    if (incidents.length === 0) {
      prevIdsRef.current = new Set();
      return;
    }

    const currentIds = new Set(incidents.map((i) => i.id));
    const previousIds = prevIdsRef.current;
    let showTimer: number | null = null;

    if (previousIds.size > 0) {
      const newInc = incidents.find((i) => !previousIds.has(i.id));
      if (newInc) {
        showTimer = window.setTimeout(() => {
          setToast(newInc);
          try {
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 880;
            osc.type = "sine";
            gain.gain.value = 0.08;
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
          } catch {
            // Audio not available
          }
          if (dismissTimerRef.current != null) {
            window.clearTimeout(dismissTimerRef.current);
          }
          dismissTimerRef.current = window.setTimeout(() => setToast(null), 4000);
        }, 0);
      }
    }

    prevIdsRef.current = currentIds;
    return () => {
      if (showTimer != null) window.clearTimeout(showTimer);
    };
  }, [incidents]);

  useEffect(() => () => {
    if (dismissTimerRef.current != null) window.clearTimeout(dismissTimerRef.current);
  }, []);

  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: -60, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -30, scale: 0.95 }}
          transition={{ type: "spring", damping: 20, stiffness: 300 }}
          className="pp-alert-toast fixed left-1/2 -translate-x-1/2 z-[2100]"
          // On mobile, anchor below the top search pill (shared CSS var)
          // so the toast never covers the pill. Desktop keeps the
          // original "below-topnav" anchor. Both fall through Tailwind
          // because the inline `top` wins on mobile and the @media rule
          // in globals.css overrides for ≥768px.
          style={{ top: "calc(var(--pp-mobile-pill-bottom) + 0.5rem)" }}
        >
          <div
            className="rounded-xl pl-4 pr-2 py-3 flex items-center gap-3 border border-red-500/30 shadow-[0_0_30px_rgba(239,68,68,0.15)] backdrop-blur-xl w-[calc(100vw-1.5rem)] max-w-[420px] sm:w-auto sm:min-w-[320px]"
            style={{ background: "var(--panel-bg)" }}
            role="status"
            aria-live="polite"
          >
            <div className="relative shrink-0">
              <AlertTriangle className="w-5 h-5 text-red-400" />
              <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red-400 rounded-full animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Radio className="w-3 h-3 text-red-400/60" />
                <span className="text-[10px] font-mono text-red-400 uppercase tracking-wider">
                  New Incident
                </span>
              </div>
              <p className="text-xs text-foreground/80 truncate">
                <span style={{ color: getSeverity(toast.severity_category).markerColor }} className="font-medium">
                  {getSeverity(toast.severity_category).label}
                </span>
                {" · "}
                {toast.location_text?.split(",")[0] || "Unknown location"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Dismiss alert"
              className="shrink-0 p-1.5 -m-1 rounded-md hover:bg-white/[0.06] transition-colors"
              style={{ color: "var(--panel-text-muted, #9ca3af)" }}
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
