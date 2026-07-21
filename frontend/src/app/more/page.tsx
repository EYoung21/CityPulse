"use client";

/**
 * Dedicated `/more` route — full-screen mobile Settings surface (quiet
 * hours / mutes / push / commute) that replaces the old
 * `?inbox=settings` drawer overlay. Reuses `AlertsInbox` with
 * `defaultPanel="settings"` so all settings stay in one component.
 * Desktop visitors keep the destination by opening the settings panel in
 * the map's existing bell-anchored drawer.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AlertsInbox from "@/components/AlertsInbox";
import MobileBottomNav from "@/components/MobileBottomNav";

export default function MorePage() {
  const router = useRouter();
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
    if (isMobile === false) router.replace("/?view=map&inbox=settings");
  }, [isMobile, router]);

  if (isMobile !== true) return null;

  return (
    <main className="min-h-dvh" style={{ background: "var(--page-bg, #0b1120)" }}>
      <h1 className="sr-only">Settings and more</h1>
      <AlertsInbox
        open
        placement="fullScreen"
        defaultPanel="settings"
        onClose={() => router.push("/?view=map")}
        onJump={(incidentId, lat, lng) => {
          window.location.href = `/?incident=${encodeURIComponent(incidentId)}&lat=${lat}&lng=${lng}&zoom=16`;
        }}
      />
      <MobileBottomNav />
    </main>
  );
}
