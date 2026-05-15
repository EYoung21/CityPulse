"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  getPrimaryNavTab,
  hrefForPrimaryNavTab,
  nextPrimaryNavTab,
  persistPrimaryNavTabIntent,
} from "@/lib/mobile-primary-tab-nav";

const MOBILE_MAX_PX = 767;
const SWIPE_MIN_DX = 56;
/** Require swipe to be more horizontal than vertical. */
const HORIZONTAL_RATIO = 1.25;
const MAP_EDGE_PX = 44;
const NAV_DEBOUNCE_MS = 480;

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`).matches;
}

function isInteractiveTouchTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, button, a[href], [role="slider"], [contenteditable="true"], [data-no-swipe-tab]'
    )
  );
}

export function useMobilePrimaryTabSwipe(opts: { enabled: boolean }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const viewParam = searchParams.get("view");

  const enabledRef = useRef(opts.enabled);
  enabledRef.current = opts.enabled;

  const startRef = useRef<{
    x: number;
    y: number;
    edgeOk: boolean;
  } | null>(null);
  const lastNavAt = useRef(0);

  const navigateByDelta = useCallback(
    (delta: -1 | 1) => {
      const now = Date.now();
      if (now - lastNavAt.current < NAV_DEBOUNCE_MS) return;
      const current = getPrimaryNavTab(pathname, viewParam);
      const next = nextPrimaryNavTab(current, delta);
      if (!next) return;
      lastNavAt.current = now;
      persistPrimaryNavTabIntent(next);
      router.push(hrefForPrimaryNavTab(next));
    },
    [pathname, viewParam, router]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onTouchStart = (e: TouchEvent) => {
      if (!enabledRef.current || !isMobileViewport()) return;
      if (isInteractiveTouchTarget(e.target)) return;
      const t = e.touches[0];
      if (!t) return;
      const w = window.innerWidth;
      const onMapHome =
        pathname === "/" &&
        (viewParam === null || viewParam === "" || viewParam === "map");
      const inEdge = t.clientX <= MAP_EDGE_PX || t.clientX >= w - MAP_EDGE_PX;
      const edgeOk = !onMapHome || inEdge;
      startRef.current = { x: t.clientX, y: t.clientY, edgeOk };
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!isMobileViewport()) {
        startRef.current = null;
        return;
      }
      const start = startRef.current;
      startRef.current = null;
      if (!enabledRef.current || !start) return;
      if (!start.edgeOk) return;

      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dx) < SWIPE_MIN_DX) return;
      if (Math.abs(dx) < Math.abs(dy) * HORIZONTAL_RATIO) return;
      if (dx < 0) navigateByDelta(1);
      else navigateByDelta(-1);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [pathname, viewParam, navigateByDelta]);
}
