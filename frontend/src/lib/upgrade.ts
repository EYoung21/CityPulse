/** Cross-component glue for triggering the global Pro upgrade modal.
 *
 *  The modal itself lives in `MapHome` (frontend/src/app/page.tsx) so it
 *  can sit above the map at z-9999. Any component buried in the tree —
 *  the saved-place limit guard in `QuickSavePlace`, the commute toggle
 *  in `AlertsInbox`, etc. — fires a `pp:show-upgrade` window event with
 *  the human-readable feature name; the page listens once and lifts the
 *  state. Keeps non-React libs (`useSavedDestinations` throws from a
 *  hook callback) able to surface the upgrade prompt without prop
 *  drilling. */

export const UPGRADE_EVENT = "pp:show-upgrade";

export interface UpgradeEventDetail {
  feature: string;
}

export function requestUpgrade(feature: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<UpgradeEventDetail>(UPGRADE_EVENT, { detail: { feature } })
  );
}

export function onUpgradeRequested(
  fn: (feature: string) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const ce = e as CustomEvent<UpgradeEventDetail>;
    fn(ce.detail?.feature || "Pro");
  };
  window.addEventListener(UPGRADE_EVENT, handler);
  return () => window.removeEventListener(UPGRADE_EVENT, handler);
}
