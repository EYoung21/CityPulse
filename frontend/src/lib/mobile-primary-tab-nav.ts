import { ASK_PULSE_AVAILABLE } from "@/lib/feature-availability";

export type PrimaryNavTab = "map" | "feed" | "ask" | "analytics";

/** Swipeable primary views. Do not leave a paused feature in this sequence:
 * swiping through a disabled Ask Pulse route otherwise gets coerced back to
 * the map and feels like a broken gesture. */
export const PRIMARY_NAV_TABS: readonly PrimaryNavTab[] = ASK_PULSE_AVAILABLE
  ? ["map", "feed", "ask", "analytics"]
  : ["map", "feed", "analytics"];

const HOME_VIEW_PREF_KEY = "cp:home-view";
const SESSION_VIEW_KEY = "pulse_view_tab";

export function getPrimaryNavTab(
  pathname: string,
  viewParam: string | null
): PrimaryNavTab {
  if (pathname.startsWith("/feed")) return "feed";
  const v = viewParam;
  if (v === "ask") return ASK_PULSE_AVAILABLE ? "ask" : "map";
  if (v === "feed" || v === "analytics" || v === "map") return v;
  return "map";
}

export function hrefForPrimaryNavTab(tab: PrimaryNavTab): string {
  if (tab === "feed") return "/feed";
  if (tab === "ask" && !ASK_PULSE_AVAILABLE) return "/?view=map";
  return `/?view=${tab}`;
}

/** Mirror `persistTabIntent` in MobileBottomNav for the four primary tabs. */
export function persistPrimaryNavTabIntent(tab: PrimaryNavTab): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(HOME_VIEW_PREF_KEY, tab === "feed" ? "feed" : "map");
  } catch {
    /* private mode */
  }
  try {
    sessionStorage.setItem(SESSION_VIEW_KEY, tab);
  } catch {
    /* ignore */
  }
}

export function nextPrimaryNavTab(
  current: PrimaryNavTab,
  delta: -1 | 1
): PrimaryNavTab | null {
  const idx = PRIMARY_NAV_TABS.indexOf(current);
  if (idx < 0) return null;
  const j = idx + delta;
  if (j < 0 || j >= PRIMARY_NAV_TABS.length) return null;
  return PRIMARY_NAV_TABS[j];
}
