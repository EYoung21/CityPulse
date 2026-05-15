"use client";

/**
 * Tiny leaf component whose only job is to react to the `?inbox=`
 * query param on the home route and notify the parent (MapHome) so
 * it can open AlertsInbox in the requested panel.
 *
 * Pulled into its own file (and wrapped in Suspense) because Next.js
 * App Router requires `useSearchParams()` callers to live inside a
 * Suspense boundary. Wrapping the whole 2,900-line MapHome in
 * Suspense would be invasive; this leaf keeps the requirement
 * scoped to ~30 lines.
 */

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export type InboxPanel = "list" | "settings" | null;
export type ViewTab = "map" | "feed" | "analytics" | "ask" | null;

interface Props {
  onInboxChange: (panel: InboxPanel) => void;
  onViewChange: (view: ViewTab) => void;
}

function Inner({ onInboxChange, onViewChange }: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  const inbox = sp?.get("inbox") ?? null;
  const view = sp?.get("view") ?? null;

  useEffect(() => {
    if (inbox === "settings") onInboxChange("settings");
    else if (inbox) onInboxChange("list");
    else onInboxChange(null);
  }, [inbox, onInboxChange]);

  useEffect(() => {
    if (view === "api") {
      router.replace("/use-cases/api");
      return;
    }
    if (view === "map" || view === "feed" || view === "analytics" || view === "ask") {
      onViewChange(view);
    }
  }, [view, onViewChange, router]);

  return null;
}

export default function InboxUrlSync(props: Props) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
}
