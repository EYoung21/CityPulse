"use client";

/**
 * AnimatedNumber
 *
 * Tweens from the currently-displayed value to a new target value using
 * requestAnimationFrame. Produces the "counter ticks up" effect on the
 * landing stats strip when /api/city-stats polls return a new count.
 *
 * - Uses an easeOutCubic for a crisp-but-smooth feel
 * - Honors `prefers-reduced-motion` (snaps instead of tweening)
 * - Formats with `toLocaleString()` by default; override via `format`
 */

import { useEffect, useRef, useState } from "react";

interface Props {
  value: number;
  /** Tween duration in ms. Default 800. */
  durationMs?: number;
  /** Custom formatter; receives the current tweened integer value. */
  format?: (n: number) => string;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function AnimatedNumber({ value, durationMs = 800, format }: Props) {
  const [displayed, setDisplayed] = useState(value);
  const fromRef = useRef(value);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // Respect reduced-motion preferences — just snap.
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced || value === displayed) {
      setDisplayed(value);
      return;
    }

    fromRef.current = displayed;
    startRef.current = null;

    function step(t: number) {
      if (startRef.current == null) startRef.current = t;
      const elapsed = t - startRef.current;
      const p = Math.min(1, elapsed / durationMs);
      const eased = easeOutCubic(p);
      const next = fromRef.current + (value - fromRef.current) * eased;
      // Render integer-ish tween for counters — avoids jittery decimals.
      setDisplayed(Math.round(next));
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    }
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, durationMs]);

  const render = format ?? ((n: number) => n.toLocaleString());
  return <>{render(displayed)}</>;
}
