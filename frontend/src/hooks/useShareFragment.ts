"use client";

import { useEffect, useState } from "react";
import {
  shareValueFromUrl,
  urlWithCanonicalShareFragment,
} from "@/lib/share-fragment";

export type ShareFragmentState =
  | { status: "loading"; value: null }
  | { status: "invalid"; value: null }
  | { status: "ready"; value: string };

/** Resolve a bearer from the URL fragment after hydration.
 *
 * Old query-string links remain usable, but are immediately rewritten into
 * the fragment form so later navigation, analytics, and referrers do not keep
 * propagating the bearer. */
export function useShareFragment(
  parameter: string,
  maxChars: number
): ShareFragmentState {
  const [state, setState] = useState<ShareFragmentState>({
    status: "loading",
    value: null,
  });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const url = new URL(window.location.href);
      const result = shareValueFromUrl(url, parameter, maxChars);
      if (!result) {
        setState({ status: "invalid", value: null });
        return;
      }

      if (result.source === "legacy-query" || url.searchParams.has(parameter)) {
        window.history.replaceState(
          {},
          "",
          urlWithCanonicalShareFragment(url, parameter, result.value)
        );
      }
      setState({ status: "ready", value: result.value });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [maxChars, parameter]);

  return state;
}
