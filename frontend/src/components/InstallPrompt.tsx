"use client";

/** Tasteful "Install CityPulse" prompt for browsers that support
 *  the `beforeinstallprompt` event (Chrome, Edge, Samsung Internet, etc).
 *
 *  Why this exists at all:
 *    - The browser's default install prompt is hidden in an overflow
 *      menu most users never open. Surfacing it inline boosts install
 *      conversion materially.
 *    - We get to choose *when* to ask — well after the user has shown
 *      intent, not on first paint where it'd feel spammy.
 *    - On iOS specifically, install is the *only* way to receive Web
 *      Push notifications (Apple gates push behind PWA installation).
 *      So this isn't just a nice-to-have on iOS — it's the unlock for
 *      keyword scanner alerts, commute predictions, and off-screen
 *      pings. The copy on iOS leads with that.
 *
 *  Behavior:
 *    - Wait for `beforeinstallprompt` (Chromium browsers fire it once
 *      conditions are met — engagement + manifest valid + service
 *      worker registered).
 *    - Defer the captured event so we control the timing.
 *    - Don't show on the first visit. Only show after the user has
 *      been on the site for 60 seconds *or* a high-intent moment fires
 *      (e.g. user tapped "enable push" while on iOS-not-installed —
 *      see `requestInstallPrompt()` below). The engagement floor
 *      keeps first-paint clean; the manual trigger lets us show
 *      exactly when the user is most receptive.
 *    - Once shown, give the user 3 choices: install, not now (snooze
 *      30 days), never (permanent dismiss). Both dismiss paths
 *      persist via localStorage.
 *    - On iOS Safari we can't use beforeinstallprompt. Detect the
 *      "standalone capable but not installed" state and show a
 *      custom mini-tutorial (Add to Home Screen) instead.
 */

/** Manual high-intent trigger. Fire this from places like the push
 *  permission flow when you've detected the user is on iOS-not-
 *  installed and they've just demonstrated they want notifications.
 *  Bypasses the engagement timer; still respects the dismiss state
 *  so we don't pester someone who has already said "never". */
export const INSTALL_PROMPT_EVENT = "pp:request-install";
export function requestInstallPrompt(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(INSTALL_PROMPT_EVENT));
}

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, X, Share2 } from "lucide-react";
import { getCurrentCity } from "@/lib/pulse-cities";

type DismissState = "snoozed" | "never" | null;

const DISMISS_KEY = "pp:install-prompt-dismissed";
const SNOOZE_DAYS = 30;
const ENGAGEMENT_DELAY_MS = 60_000;

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

function loadDismiss(): DismissState {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as { kind: DismissState; at?: number };
    if (obj.kind === "never") return "never";
    if (obj.kind === "snoozed" && typeof obj.at === "number") {
      const ageMs = Date.now() - obj.at;
      if (ageMs < SNOOZE_DAYS * 24 * 60 * 60 * 1000) return "snoozed";
      return null;
    }
  } catch { /* ignore */ }
  return null;
}

function saveDismiss(kind: "snoozed" | "never"): void {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify({ kind, at: Date.now() }));
  } catch { /* ignore */ }
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // navigator.standalone is the iOS Safari signal; matchMedia covers
  // the rest (Chrome PWA on desktop & Android, Edge, Samsung).
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone) return true;
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS reports as MacIntel + touch — sniff that too.
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [visible, setVisible] = useState(false);
  // Per-deployment brand (e.g. "423Pulse", "PhillyPulse") — falls back
  // to "CityPulse" during SSR / when running on a non-mapped host.
  const brand = useMemo<string>(() => {
    if (typeof window === "undefined") return "CityPulse";
    try {
      return getCurrentCity().brand ?? "CityPulse";
    } catch {
      return "CityPulse";
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isStandalone()) return; // Already installed.
    if (loadDismiss() !== null) return; // User said no recently.

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // iOS Safari: no event, but we can still nudge the user. Defer to
    // the engagement timeout so first-paint is uncluttered.
    let iosTimer: number | undefined;
    if (isIos()) {
      iosTimer = window.setTimeout(() => setIosHint(true), ENGAGEMENT_DELAY_MS);
    }

    // Engagement gate — even if we have the deferred event, hold off
    // on showing the banner until the user has been around long enough
    // to know what we are.
    const showTimer = window.setTimeout(() => setVisible(true), ENGAGEMENT_DELAY_MS);

    // High-intent override: when a feature like "enable push" detects
    // it can't proceed without the PWA being installed, it dispatches
    // INSTALL_PROMPT_EVENT. Skip the engagement timer and show now.
    // Still honor the dismiss state — if the user has already said
    // "never" we don't override that.
    const onManualRequest = () => {
      if (loadDismiss() === "never") return;
      setVisible(true);
      if (isIos()) setIosHint(true);
    };
    window.addEventListener(INSTALL_PROMPT_EVENT, onManualRequest);

    // If the user installs through the browser's native UI, drop our
    // prompt so it doesn't keep nagging.
    const onInstalled = () => {
      setDeferred(null);
      setVisible(false);
      setIosHint(false);
    };
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener(INSTALL_PROMPT_EVENT, onManualRequest);
      window.removeEventListener("appinstalled", onInstalled);
      window.clearTimeout(showTimer);
      if (iosTimer) window.clearTimeout(iosTimer);
    };
  }, []);

  // Show only if (a) we've waited the engagement timer AND (b) we have
  // either a deferred event OR an iOS device that could AddToHomeScreen.
  const shouldShow = visible && (deferred !== null || iosHint);
  if (!shouldShow) return null;

  const handleInstall = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      // Either way, drop the deferred event; chromium spec says you
      // can only call prompt() once per event.
      setDeferred(null);
      if (choice.outcome === "accepted") {
        setVisible(false);
      } else {
        // User declined the *native* prompt — count it as a snooze
        // and don't ask again for a while.
        saveDismiss("snoozed");
        setVisible(false);
      }
    } catch {
      setDeferred(null);
    }
  };

  const handleSnooze = () => {
    saveDismiss("snoozed");
    setVisible(false);
    setIosHint(false);
  };

  const handleNever = () => {
    saveDismiss("never");
    setVisible(false);
    setIosHint(false);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 80, opacity: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
        className="fixed inset-x-0 z-[1080] flex justify-center px-3 pointer-events-none"
        // Sit above the bottom navigation but below blocking modals
        // (KeyboardShortcutsHelp uses z-1100; UndoToastHost ~ 1095).
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }}
        role="dialog"
        aria-label={`Install ${brand}`}
      >
        <div
          className="pointer-events-auto w-full max-w-sm rounded-2xl shadow-2xl backdrop-blur-xl overflow-hidden"
          style={{
            background: "var(--panel-bg)",
            border: "1px solid var(--panel-border)",
          }}
        >
          <div className="px-4 py-3 flex items-start gap-3">
            <div
              className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center"
              style={{
                background: "rgba(59,130,246,0.15)",
                color: "#3b82f6",
              }}
            >
              {iosHint && !deferred ? (
                <Share2 className="w-5 h-5" />
              ) : (
                <Download className="w-5 h-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold" style={{ color: "var(--panel-text)" }}>
                {iosHint && !deferred ? "Get safety alerts on iOS" : `Install ${brand}`}
              </p>
              {deferred ? (
                <p className="text-[11px] mt-0.5 leading-snug" style={{ color: "var(--panel-text-muted)" }}>
                  Get instant launches, an app icon, offline support, and
                  push alerts when {brand} isn&rsquo;t open.
                </p>
              ) : (
                <p className="text-[11px] mt-0.5 leading-snug" style={{ color: "var(--panel-text-muted)" }}>
                  Apple requires installing {brand} to your home screen
                  before it can send alerts. Tap{" "}
                  <Share2 className="inline w-3 h-3 align-text-top mx-0.5" />{" "}
                  Share, then <span className="font-medium">&ldquo;Add to Home Screen&rdquo;</span>.
                </p>
              )}
            </div>
            <button
              onClick={handleSnooze}
              className="p-1 rounded-md hover:bg-white/10 transition-colors shrink-0"
              aria-label="Dismiss for now"
              title="Maybe later"
            >
              <X className="w-4 h-4" style={{ color: "var(--panel-text-muted)" }} />
            </button>
          </div>
          {deferred && (
            <div className="px-4 pb-3 flex items-center gap-2">
              <button
                onClick={handleInstall}
                className="flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors"
                style={{ background: "#3b82f6", color: "white" }}
              >
                Install
              </button>
              <button
                onClick={handleSnooze}
                className="px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                style={{
                  background: "var(--panel-input-bg)",
                  color: "var(--panel-text-muted)",
                }}
              >
                Not now
              </button>
              <button
                onClick={handleNever}
                className="px-2.5 py-2 rounded-lg text-xs font-medium transition-colors"
                style={{ color: "var(--panel-text-muted)" }}
                title="Don't ask again"
              >
                Never
              </button>
            </div>
          )}
          {!deferred && iosHint && (
            <div className="px-4 pb-3 flex items-center justify-end gap-2">
              <button
                onClick={handleSnooze}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{
                  background: "var(--panel-input-bg)",
                  color: "var(--panel-text-muted)",
                }}
              >
                Got it
              </button>
              <button
                onClick={handleNever}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{ color: "var(--panel-text-muted)" }}
              >
                Don&apos;t ask again
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
