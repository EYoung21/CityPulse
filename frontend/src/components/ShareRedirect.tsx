"use client";

import { useEffect } from "react";

/** Client-side bounce used by /share. Crawlers (which don't run JS) read the
 *  page's metadata for the unfurl card; real users get redirected within
 *  ~50ms so the share-link feels like it lands directly in the app. */
export default function ShareRedirect({ appUrl }: { appUrl: string }) {
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        window.location.replace(appUrl);
      } catch {
        window.location.href = appUrl;
      }
    }, 50);
    return () => window.clearTimeout(t);
  }, [appUrl]);
  return null;
}
