"use client";

import { useEffect, useState } from "react";

/** SSR-safe matchMedia hook. Defaults to `false` on the server so that
 *  hydration matches the desktop tree (no layout shift on most loads). */
export function useIsMobile(maxWidthPx = 767): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(`(max-width: ${maxWidthPx}px)`);
    const apply = () => setIsMobile(mql.matches);
    apply();
    mql.addEventListener?.("change", apply);
    return () => mql.removeEventListener?.("change", apply);
  }, [maxWidthPx]);

  return isMobile;
}
