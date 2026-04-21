"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Keep the screen awake while a condition is true.
 *
 * Mirrors what Google Maps / Citizen do during active navigation:
 * the OS would normally dim the screen after 30s of no touches, which
 * is the wrong default when a user is walking with the phone in hand
 * watching their dot creep along a route.
 *
 * Spec: https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
 *
 * Browser support is good in modern Chromium / WebKit but absent in
 * Firefox-mobile and older iOS. We probe for the API and silently
 * no-op when it isn't there — there's nothing useful to fall back to
 * on the web (a hidden video element trick exists but battery cost is
 * unjustifiable for a feature that benefits a minority of devices).
 *
 * Wake locks are also released by the browser whenever the page is
 * hidden (tab switch, screen lock). We listen for `visibilitychange`
 * and re-acquire on return so a quick lock-screen check doesn't kill
 * navigation for the rest of the trip.
 */

type WakeLockSentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
};

export interface WakeLockState {
  /** Browser actually supports the API (and we're in a secure context). */
  supported: boolean;
  /** A sentinel is currently held — i.e. the screen is being kept on. */
  active: boolean;
}

export function useWakeLock(enabled: boolean): WakeLockState {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const [active, setActive] = useState(false);
  const supported =
    typeof navigator !== "undefined" &&
    (navigator as WakeLockNavigator).wakeLock != null;

  useEffect(() => {
    if (!supported || !enabled) {
      // If we held a lock and the caller turned the gate off, release
      // it immediately rather than waiting for unmount. Otherwise the
      // screen stays on after the trip ends, which the user almost
      // certainly doesn't want.
      const s = sentinelRef.current;
      if (s && !s.released) {
        s.release().catch(() => {});
      }
      sentinelRef.current = null;
      setActive(false);
      return;
    }

    let cancelled = false;

    const acquire = async () => {
      try {
        const nav = navigator as WakeLockNavigator;
        if (!nav.wakeLock) return;
        const sentinel = await nav.wakeLock.request("screen");
        if (cancelled) {
          await sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
        setActive(true);
        // The browser releases the lock when the page is hidden;
        // when we come back we want it again.
        sentinel.addEventListener("release", () => {
          sentinelRef.current = null;
          setActive(false);
        });
      } catch {
        // Permission denied / page hidden / battery saver — nothing
        // we can do, the lock is best-effort.
        setActive(false);
      }
    };

    void acquire();

    const onVis = () => {
      if (document.visibilityState === "visible" && enabled && !sentinelRef.current) {
        void acquire();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      const s = sentinelRef.current;
      if (s && !s.released) {
        s.release().catch(() => {});
      }
      sentinelRef.current = null;
      setActive(false);
    };
  }, [supported, enabled]);

  return { supported, active };
}
