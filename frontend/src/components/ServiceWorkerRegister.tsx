"use client";

/**
 * ServiceWorkerRegister
 *
 * Registers /sw.js once the page has finished loading, in production builds
 * only. The service worker is what powers offline tile caching, push
 * notifications, and the home-screen PWA experience.
 *
 * See `docs/MOBILE-PWA.md` for a concise device smoke checklist.
 *
 * The install-prompt UI used to live here too, but it duplicated the
 * dedicated `InstallPrompt` component (engagement timer, dismiss memory,
 * dynamic city branding) and even fired on the marketing landing page
 * with hardcoded "PhillyPulse" copy. That responsibility now lives
 * exclusively in `InstallPrompt`, mounted on the in-app routes only.
 */

import { useEffect } from "react";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((err) => console.warn("[pp] SW registration failed", err));
    };
    if (document.readyState === "complete") {
      onLoad();
    } else {
      window.addEventListener("load", onLoad, { once: true });
      return () => window.removeEventListener("load", onLoad);
    }
  }, []);

  return null;
}
