"use client";

/**
 * Dedicated `/inbox` route — full-screen mobile surface that replaces
 * the old `?inbox=1` drawer overlay. The mobile bottom-nav Inbox tab
 * routes here so it behaves like Map/Feed/Ask/Analytics (its own page)
 * instead of opening a modal on top of whatever surface the user was
 * on. On desktop we leave the existing map-bell drawer alone and just
 * bounce visitors back to the map.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AlertsInbox from "@/components/AlertsInbox";
import MobileBottomNav from "@/components/MobileBottomNav";

export default function InboxPage() {
  const router = useRouter();
  // Desktop users have the map's bell-anchored inbox — don't render a
  // dedicated surface for them; bounce back home instead.
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsMobile(mql.matches);
    apply();
    if (mql.addEventListener) mql.addEventListener("change", apply);
    else mql.addListener(apply);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", apply);
      else mql.removeListener(apply);
    };
  }, []);

  useEffect(() => {
    if (isMobile === false) router.replace("/?view=map");
  }, [isMobile, router]);

  if (isMobile !== true) return null;

  return (
    <div className="min-h-dvh" style={{ background: "var(--page-bg, #0b1120)" }}>
      <AlertsInbox
        open
        placement="fullScreen"
        defaultPanel="list"
        onClose={() => router.push("/?view=map")}
        onJump={(incidentId, lat, lng) => {
          window.location.href = `/?incident=${encodeURIComponent(incidentId)}&lat=${lat}&lng=${lng}&zoom=16`;
        }}
      />
      <MobileBottomNav />
    </div>
  );
}
