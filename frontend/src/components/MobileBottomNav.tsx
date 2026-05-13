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

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
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

/** Standard iOS-style tab bar height (excluding the safe-area inset
 *  for the home indicator, which we add on top). Exported so the map
 *  page can pad the bottom of any UI it doesn't want overlapped. */
export const MOBILE_NAV_HEIGHT_PX = 64;

// Inner component that uses `useSearchParams` — extracted so we can
// wrap *only this slice* in <Suspense>. Next.js requires a Suspense
// boundary anywhere `useSearchParams()` is called inside the App
// Router; the boundary is what lets the rest of the page keep
// rendering even when the search params haven't been hydrated yet.
function MobileBottomNavInner() {
  const [show, setShow] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [unread, setUnread] = useState(0);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 767px)");
    const apply = () => setShow(mql.matches);
    apply();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    } else if (typeof mql.addListener === "function") {
      mql.addListener(apply);
      return () => mql.removeListener(apply);
    }
  }, []);

  useEffect(() => {
    setUnread(unreadCount());
    return subscribeAlerts(() => setUnread(unreadCount()));
  }, []);

  const { isPro } = useAuth();
  if (!show || !mounted) return null;

  const inboxParam = searchParams?.get("inbox") ?? null;
  const viewParam = searchParams?.get("view") ?? null;
  const onFeed = pathname?.startsWith("/feed") ?? false;
  const activeId: TabId = onFeed
    ? "feed"
    : viewParam === "analytics"
      ? "analytics"
      : inboxParam === "settings"
        ? "settings"
        : inboxParam
          ? "inbox"
          : "map";

  const nav = (
    <nav
      aria-label="Primary"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 10050,
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
          <Link
            key={tab.id}
            href={tab.href}
            replace
            prefetch={false}
            scroll={false}
            aria-label={tab.label}
            aria-current={active ? "page" : undefined}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 no-underline"
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
          </Link>
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
