/** Tiny global pub-sub for "what view is the SearchSidebar in".
 *
 *  Used by leaf components (PlaceActions, future Add-stop UIs) to
 *  show or hide controls that only make sense while the user is
 *  actively planning a route or running a trip — without forcing
 *  them to subscribe to SearchSidebar's internal state directly.
 *
 *  Source of truth lives in `SearchSidebar`, which calls
 *  `publishRouteState()` whenever its `view`/`originLoc`/`destLoc`/
 *  `tripActive` flags change. The current snapshot is also held in
 *  module scope so late-mounting subscribers (popovers, drawers
 *  opened mid-flow) get the right initial value without waiting for
 *  the next change event.
 */

export type RouteView = "search" | "directions" | "trip";

export interface RouteState {
  view: RouteView;
  hasOrigin: boolean;
  hasDest: boolean;
  /** True while a trip is in-progress (post-GO, pre-end). Distinct
   *  from `view === "trip"` so a renderer can react to either the
   *  intent (planning) or the actual state (navigating). */
  tripActive: boolean;
}

const DEFAULT_STATE: RouteState = {
  view: "search",
  hasOrigin: false,
  hasDest: false,
  tripActive: false,
};

let current: RouteState = { ...DEFAULT_STATE };
const listeners = new Set<(s: RouteState) => void>();

function shallowEqual(a: RouteState, b: RouteState): boolean {
  return (
    a.view === b.view &&
    a.hasOrigin === b.hasOrigin &&
    a.hasDest === b.hasDest &&
    a.tripActive === b.tripActive
  );
}

/** Update the shared route state. Call this from SearchSidebar (or
 *  any other route-planning host) whenever the user-visible state
 *  changes. Cheap to call repeatedly — it short-circuits when the
 *  snapshot is unchanged so we don't churn React subscribers. */
export function publishRouteState(next: RouteState): void {
  if (shallowEqual(current, next)) return;
  current = { ...next };
  for (const fn of listeners) {
    try {
      fn(current);
    } catch (err) {
      console.warn("[pp] route-state listener threw", err);
    }
  }
}

/** Imperative read for non-reactive callers (e.g. event handlers in
 *  refs). React components should prefer `useRouteState()`. */
export function getRouteState(): RouteState {
  return current;
}

/** Subscribe to route-state changes. Returns an unsubscribe fn. */
export function subscribeRouteState(fn: (s: RouteState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// React hook lives at the bottom of this module — colocated with the
// pubsub it wraps so consumers only have one import. We avoid pulling
// React at module top-level because this file is also imported from
// non-component code (event handlers, libs); React's tree-shaker is
// fine with a re-exported import inside an exported fn.
import { useEffect, useState } from "react";

/** React subscription helper. Returns the latest published RouteState
 *  and re-renders on change. Safe in SSR (returns the default state
 *  during the initial render, then hydrates from `current`). */
export function useRouteState(): RouteState {
  const [state, setState] = useState<RouteState>(current);
  useEffect(() => {
    setState(current);
    return subscribeRouteState(setState);
  }, []);
  return state;
}
