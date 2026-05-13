"use client";

/**
 * Persistent bottom tab bar for the mobile-sized viewport.
 *
 * Per the build plan §4: `[Map] [Feed] [Inbox] [Settings]`. This
 * supersedes the floating `MobileFeedReturnPill` (which is now
 * removed from MapHome) — the bar is the canonical way to swap
 * between the four primary surfaces on a phone.
 *
 * Routing model:
 *   - Map     → `/?view=map`            (sticks the map preference)
 *   - Feed    → `/feed`
 *   - Inbox   → `/?view=map&inbox=1`    (opens AlertsInbox in list mode)
 *   - Settings→ `/?view=map&inbox=settings`
 *                                       (opens AlertsInbox on Settings)
 *
 * `MapHome` (`app/page.tsx`) reads the `inbox` query param on mount
 * and toggles `showInbox` + the inbox's `defaultPanel` accordingly,
 * so the URL hint round-trips into UI state.
 *
 * The bar is *only* rendered when the viewport is ≤767px — desktop
 * keeps the existing top-bar nav. We render `null` on desktop so the
 * map's bottom-edge controls (compass, recenter, etc.) keep their
 * full real estate.
 */

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useSyncExternalStore, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Map as MapIcon, List, Bell, Settings as SettingsIcon, BarChart3, Lock } from "lucide-react";
import { subscribeAlerts, unreadCount } from "@/lib/alerts-inbox";
import { useAuth } from "@/contexts/AuthContext";

// API Docs (`/use-cases/api`) intentionally not in the bottom nav: it's
// reachable from the More menu and from the Analytics header. Surfacing it
// here would crowd the bar past the iOS-style 5-icon comfort zone.
type TabId = "map" | "feed" | "analytics" | "inbox" | "settings";

interface Tab {
  id: TabId;
  label: string;
  href: string;
  Icon: React.ComponentType<{ className?: string }>;
  pro?: boolean;
}

const TABS: Tab[] = [
  { id: "map",       label: "Map",       href: "/?view=map",                Icon: MapIcon },
  { id: "feed",      label: "Feed",      href: "/feed",                     Icon: List },
  { id: "analytics", label: "Analytics", href: "/?view=analytics",          Icon: BarChart3, pro: true },
  { id: "inbox",     label: "Inbox",     href: "/?view=map&inbox=1",        Icon: Bell },
  { id: "settings",  label: "More",      href: "/?view=map&inbox=settings", Icon: SettingsIcon },
];

const HOME_VIEW_PREF_KEY = "cp:home-view";
const SESSION_VIEW_KEY = "pulse_view_tab";
const MOBILE_QUERY = "(max-width: 767px)";

/** Standard iOS-style tab bar height (excluding the safe-area inset
 *  for the home indicator, which we add on top). Exported so the map
 *  page can pad the bottom of any UI it doesn't want overlapped. */
export const MOBILE_NAV_HEIGHT_PX = 64;

function navigateToTab(href: string) {
  if (typeof window === "undefined") return;
  window.location.href = href;
}

function readSessionViewTab(): TabId | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = sessionStorage.getItem(SESSION_VIEW_KEY);
    if (saved === "feed" || saved === "analytics" || saved === "map") return saved;
  } catch {
    /* non-fatal */
  }
  return null;
}

function persistTabIntent(tab: Tab) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(HOME_VIEW_PREF_KEY, tab.id === "feed" ? "feed" : "map");
  } catch {
    /* storage can be unavailable in private browsing */
  }
  try {
    sessionStorage.setItem(
      SESSION_VIEW_KEY,
      tab.id === "analytics" ? "analytics" : tab.id === "feed" ? "feed" : "map"
    );
  } catch {
    /* non-fatal */
  }
}

function subscribeMobileViewport(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(MOBILE_QUERY);
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onStoreChange);
    return () => mql.removeEventListener("change", onStoreChange);
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(onStoreChange);
    return () => mql.removeListener(onStoreChange);
  }
  return () => {};
}

function getMobileViewportSnapshot() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_QUERY).matches;
}

function getServerMobileViewportSnapshot() {
  return false;
}

function subscribeUnread(onStoreChange: () => void) {
  return subscribeAlerts(() => onStoreChange());
}

function getUnreadSnapshot() {
  return unreadCount();
}

function getServerUnreadSnapshot() {
  return 0;
}

// Inner component that uses `useSearchParams` — extracted so we can
// wrap *only this slice* in <Suspense>. Next.js requires a Suspense
// boundary anywhere `useSearchParams()` is called inside the App
// Router; the boundary is what lets the rest of the page keep
// rendering even when the search params haven't been hydrated yet.
function MobileBottomNavInner() {
  const show = useSyncExternalStore(
    subscribeMobileViewport,
    getMobileViewportSnapshot,
    getServerMobileViewportSnapshot
  );
  const unread = useSyncExternalStore(
    subscribeUnread,
    getUnreadSnapshot,
    getServerUnreadSnapshot
  );
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { isPro } = useAuth();
  if (!show) return null;

  const inboxParam = searchParams?.get("inbox") ?? null;
  const viewParam = searchParams?.get("view") ?? null;
  const onFeed = pathname?.startsWith("/feed") ?? false;
  const sessionView = pathname === "/" ? readSessionViewTab() : null;
  const activeId: TabId = onFeed
    ? "feed"
    : viewParam === "feed"
      ? "feed"
      : viewParam === "analytics"
        ? "analytics"
        : sessionView === "feed"
          ? "feed"
          : sessionView === "analytics"
            ? "analytics"
            : inboxParam === "settings"
              ? "settings"
              : inboxParam
                ? "inbox"
                : "map";

  const handleTabActivate = (tab: Tab) => {
    persistTabIntent(tab);
    if (activeId === tab.id) return;
    navigateToTab(tab.href);
  };

  const handleTabPointerUp = (tab: Tab) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    handleTabActivate(tab);
  };

  const nav = (
    <nav
      aria-label="Primary"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2147483000,
        isolation: "isolate",
        transform: "translateZ(0)",
        display: "flex",
        alignItems: "stretch",
        justifyContent: "space-around",
        height: `calc(${MOBILE_NAV_HEIGHT_PX}px + env(safe-area-inset-bottom, 0px))`,
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        background: "rgba(15,23,42,0.92)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderTop: "1px solid rgba(148,163,184,0.18)",
        boxShadow: "0 -2px 12px rgba(0,0,0,0.35)",
        pointerEvents: "auto",
        touchAction: "manipulation",
      }}
    >
      {TABS.map((tab) => {
        const active = activeId === tab.id;
        const showPro = tab.pro && !isPro;
        return (
          <button
            key={tab.id}
            type="button"
            aria-label={tab.label}
            aria-current={active ? "page" : undefined}
            onPointerUp={handleTabPointerUp(tab)}
            className="flex-1 flex flex-col items-center justify-center gap-0.5"
            style={{
              color: active ? "#60a5fa" : "#94a3b8",
              transition: "color 120ms ease",
              position: "relative",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
              paddingTop: 4,
              paddingBottom: 2,
              touchAction: "manipulation",
            }}
          >
            <span style={{ position: "relative", lineHeight: 0 }}>
              <tab.Icon className="w-5.5 h-5.5" />
              {showPro && (
                <span
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -10,
                    width: 12,
                    height: 12,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "50%",
                    background: "rgba(139,92,246,0.9)",
                    color: "#fff",
                  }}
                >
                  <Lock className="w-2 h-2" />
                </span>
              )}
              {tab.id === "inbox" && unread > 0 && (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -8,
                    minWidth: 16,
                    height: 16,
                    padding: "0 4px",
                    borderRadius: 9999,
                    background: "#ef4444",
                    color: "#fff",
                    fontSize: 9,
                    fontWeight: 700,
                    lineHeight: "16px",
                    textAlign: "center",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: active ? 700 : 500,
                letterSpacing: 0.1,
              }}
            >
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );

  return createPortal(nav, document.body);
}

export default function MobileBottomNav() {
  // The Suspense fallback renders nothing — the nav is non-essential
  // chrome, and the alternative (a flash of blank bar) is uglier than
  // a one-frame absence.
  return (
    <Suspense fallback={null}>
      <MobileBottomNavInner />
    </Suspense>
  );
}
