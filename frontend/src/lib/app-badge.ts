/**
 * Thin wrapper around the Badging API.
 *
 * Spec: https://developer.mozilla.org/en-US/docs/Web/API/Badging_API
 *
 * Lights up the unread count on:
 *   - Installed PWAs on Chrome/Edge (desktop + ChromeOS)
 *   - iOS 16.4+ Safari PWAs added to home screen
 *
 * Falls back to a no-op everywhere else (Firefox-mobile, plain browser
 * tabs). The browser-tab case is intentional — there's no badge surface
 * outside of an installed app, and we already show the unread count
 * on the in-app bell button anyway, so we lose nothing.
 *
 * Per the spec, passing 0 (or no argument) clears the badge entirely
 * rather than rendering "0", so callers can wire this directly to the
 * unread counter without a special-case branch.
 */

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export function isAppBadgeSupported(): boolean {
  return typeof navigator !== "undefined" && "setAppBadge" in navigator;
}

export function setAppBadge(count: number): void {
  if (typeof navigator === "undefined") return;
  const nav = navigator as BadgeNavigator;
  try {
    if (count <= 0) {
      void nav.clearAppBadge?.().catch(() => {});
      return;
    }
    void nav.setAppBadge?.(Math.max(0, Math.floor(count))).catch(() => {});
  } catch {
    // Intentional: badge writes are best-effort, never user-facing on failure.
  }
}

export function clearAppBadge(): void {
  if (typeof navigator === "undefined") return;
  const nav = navigator as BadgeNavigator;
  try {
    void nav.clearAppBadge?.().catch(() => {});
  } catch {
    // ignore
  }
}
