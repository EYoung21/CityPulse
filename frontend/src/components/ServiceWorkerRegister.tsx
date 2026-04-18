"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

/** Chromium fires `beforeinstallprompt` only when the PWA install criteria are
 *  met. iOS Safari never fires it, so we don't render the button there — the
 *  user installs via the share sheet instead. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "pp:install-dismissed-at";
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default function ServiceWorkerRegister() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      const onLoad = () => {
        navigator.serviceWorker
          .register("/sw.js", { scope: "/" })
          .catch((err) => console.warn("[pp] SW registration failed", err));
      };
      if (document.readyState === "complete") onLoad();
      else window.addEventListener("load", onLoad, { once: true });
    }

    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || "0");
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) return;

    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (isStandalone) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
      setHidden(false);
    };
    const onInstalled = () => {
      setInstallEvent(null);
      setHidden(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (hidden || !installEvent) return null;

  const onInstall = async () => {
    try {
      await installEvent.prompt();
      const { outcome } = await installEvent.userChoice;
      if (outcome === "dismissed") {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
      }
    } catch {
      /* user cancelled */
    }
    setInstallEvent(null);
    setHidden(true);
  };

  const onDismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setHidden(true);
  };

  return (
    <div
      role="dialog"
      aria-label="Install PhillyPulse"
      className="fixed z-[1100] left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-2 rounded-full shadow-2xl text-xs font-medium backdrop-blur-xl"
      style={{
        bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))",
        background: "var(--panel-bg)",
        border: "1px solid var(--panel-border)",
        color: "var(--panel-text)",
        maxWidth: "calc(100vw - 1.5rem)",
      }}
    >
      <Download className="w-4 h-4 text-blue-500 shrink-0" />
      <span className="truncate">Install PhillyPulse for faster access</span>
      <button
        type="button"
        onClick={onInstall}
        className="px-2.5 py-1 rounded-full bg-blue-500 text-white text-[11px] font-semibold shrink-0"
      >
        Install
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss install prompt"
        className="p-1 -m-1 shrink-0"
        style={{ color: "var(--panel-text-muted)" }}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
