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
import { useSearchParams } from "next/navigation";

export type InboxPanel = "list" | "settings" | null;

interface Props {
  onChange: (panel: InboxPanel) => void;
}

function Inner({ onChange }: Props) {
  const sp = useSearchParams();
  const v = sp?.get("inbox") ?? null;
  useEffect(() => {
    if (v === "settings") onChange("settings");
    else if (v) onChange("list");
    else onChange(null);
  }, [v, onChange]);
  return null;
}

export default function InboxUrlSync(props: Props) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
}
