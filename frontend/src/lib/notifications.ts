/** Web-Notifications wrapper that quietly no-ops on browsers without
 *  the API (Safari iOS, etc.) or when the user has denied permission.
 *
 *  Permission is requested lazily — we only prompt the first time a
 *  notification is actually being fired *and* the page isn't visible,
 *  so users don't see a permission dialog the moment they open the
 *  app. The decision is cached in `localStorage` so we don't re-prompt
 *  every session if they ignore it. */

const STORAGE_KEY = "pp:notif-prompted";

function alreadyPrompted(): boolean {
  if (typeof window === "undefined") return true;
  try { return window.localStorage.getItem(STORAGE_KEY) === "1"; }
  catch { return true; }
}

function markPrompted() {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(STORAGE_KEY, "1"); }
  catch { /* storage full / blocked — non-fatal */ }
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  const N = window.Notification;
  if (N.permission === "granted") return true;
  if (N.permission === "denied") return false;
  if (alreadyPrompted()) return false; // user ignored the last prompt
  markPrompted();
  try {
    const res = await N.requestPermission();
    return res === "granted";
  } catch {
    return false;
  }
}

interface NotifyOptions {
  title: string;
  body: string;
  /** Stable key used as the notification `tag` so a second notification
   *  with the same key replaces the first (rather than stacking). */
  tag?: string;
  onClick?: () => void;
}

/** Fire-and-forget. Returns false if not delivered (no support, denied,
 *  page visible, etc.). Never throws. */
export async function notifyIfBackgrounded(opts: NotifyOptions): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!notificationsSupported()) return false;
  // Only notify when the user can't see the page already (otherwise
  // we'd be screaming into a foreground tab — the in-app chip already
  // handles that case).
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    return false;
  }
  const granted = await ensureNotificationPermission();
  if (!granted) return false;
  try {
    const n = new window.Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    });
    if (opts.onClick) {
      n.onclick = () => {
        try { window.focus(); } catch { /* popup blocked */ }
        opts.onClick?.();
        n.close();
      };
    }
    return true;
  } catch {
    return false;
  }
}
