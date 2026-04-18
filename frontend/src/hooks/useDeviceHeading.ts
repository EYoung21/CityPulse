"use client";

import { useEffect, useRef, useState } from "react";

/** A safari-only addition to DeviceOrientationEvent — gates compass access
 *  behind a user-gesture-triggered permission prompt. */
type IOSDeviceOrientationEvent = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

interface DOEvent extends Event {
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
  /** iOS only: pre-corrected for true north. */
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
  absolute?: boolean;
}

/** Returns the device's compass heading in degrees (0=N, 90=E, …, clockwise),
 *  or `null` while unsupported / not yet permitted. The value is smoothed
 *  (low-pass filter, alpha=0.2) to avoid jittery rotations and updated at
 *  most ~10Hz to keep CSS transforms cheap.
 *
 *  iOS Safari requires a user-gesture-triggered call to
 *  `DeviceOrientationEvent.requestPermission()`. Pass `enabled=true` from a
 *  click handler to trigger that prompt — until the user grants, the hook
 *  returns null and silently no-ops. */
export function useDeviceHeading(enabled = true): number | null {
  const [heading, setHeading] = useState<number | null>(null);
  const lastEmitRef = useRef<number>(0);
  const smoothedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (!("DeviceOrientationEvent" in window)) return;

    let cancelled = false;
    let absoluteListener: ((e: DOEvent) => void) | null = null;
    let listener: ((e: DOEvent) => void) | null = null;

    const onEvent = (e: DOEvent) => {
      let raw: number | null = null;
      if (typeof e.webkitCompassHeading === "number") {
        raw = e.webkitCompassHeading;
      } else if (typeof e.alpha === "number" && e.alpha !== null) {
        // Web standard: alpha = rotation around z-axis. 0 = device's local
        // "front" (which we approximate as north when `absolute` is true).
        raw = 360 - e.alpha;
      }
      if (raw === null || !Number.isFinite(raw)) return;
      const normalized = ((raw % 360) + 360) % 360;

      // Low-pass filter — handle the seam at 0/360 by always going the
      // shorter way around the circle.
      const prev = smoothedRef.current;
      let next: number;
      if (prev === null) {
        next = normalized;
      } else {
        let delta = normalized - prev;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        next = (prev + delta * 0.2 + 360) % 360;
      }
      smoothedRef.current = next;

      const now = performance.now();
      if (now - lastEmitRef.current < 100) return;
      lastEmitRef.current = now;
      if (!cancelled) setHeading(next);
    };

    const subscribe = () => {
      // `deviceorientationabsolute` is more reliable on Android (gives true
      // north). Fall back to plain `deviceorientation` if not available.
      absoluteListener = onEvent;
      listener = onEvent;
      window.addEventListener("deviceorientationabsolute", absoluteListener as EventListener);
      window.addEventListener("deviceorientation", listener as EventListener);
    };

    const ios = DeviceOrientationEvent as unknown as IOSDeviceOrientationEvent;
    if (typeof ios.requestPermission === "function") {
      ios.requestPermission()
        .then((res) => { if (res === "granted") subscribe(); })
        .catch(() => { /* user dismissed or unsupported — silent */ });
    } else {
      subscribe();
    }

    return () => {
      cancelled = true;
      if (absoluteListener) {
        window.removeEventListener("deviceorientationabsolute", absoluteListener as EventListener);
      }
      if (listener) {
        window.removeEventListener("deviceorientation", listener as EventListener);
      }
    };
  }, [enabled]);

  return heading;
}
