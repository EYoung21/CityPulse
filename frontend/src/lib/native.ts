/** Cross-platform helpers that prefer native Capacitor APIs when running
 *  inside the iOS/Android shell, and fall back to the equivalent web API
 *  otherwise. All imports are dynamic so the web bundle stays small — the
 *  Capacitor packages are tree-shaken out of the web build.
 *
 *  Usage:
 *    import { share, haptic, getCurrentPosition } from "@/lib/native";
 *    await share({ title: "Pin", url: "https://..." });
 *    haptic("light");
 *    const pos = await getCurrentPosition();
 */

export type HapticIntensity = "light" | "medium" | "heavy" | "selection";

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function getCap(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { Capacitor?: CapacitorGlobal };
  return w.Capacitor ?? null;
}

export function isNative(): boolean {
  const cap = getCap();
  return cap?.isNativePlatform?.() === true;
}

export function platform(): "ios" | "android" | "web" {
  const cap = getCap();
  const p = cap?.getPlatform?.();
  if (p === "ios" || p === "android") return p;
  return "web";
}

export interface ShareData {
  title?: string;
  text?: string;
  url?: string;
  /** Optional dialog title shown on Android. */
  dialogTitle?: string;
}

/** Share text/URL via the native sheet on iOS/Android, or `navigator.share`
 *  on the web. Falls back to clipboard when neither is available. Resolves
 *  to true on success, false on user cancel or unsupported. */
export async function share(data: ShareData): Promise<boolean> {
  if (isNative()) {
    try {
      const mod = await import("@capacitor/share");
      await mod.Share.share({
        title: data.title,
        text: data.text,
        url: data.url,
        dialogTitle: data.dialogTitle,
      });
      return true;
    } catch {
      /* user cancelled or plugin unavailable — fall through */
    }
  }
  if (typeof navigator !== "undefined" && "share" in navigator) {
    try {
      await navigator.share({ title: data.title, text: data.text, url: data.url });
      return true;
    } catch {
      /* user cancelled */
    }
  }
  if (data.url && typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(data.url);
      return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Tactile feedback. Native tap on iOS/Android, `navigator.vibrate` on web,
 *  no-op when neither is available. */
export async function haptic(intensity: HapticIntensity = "light"): Promise<void> {
  if (isNative()) {
    try {
      const mod = await import("@capacitor/haptics");
      if (intensity === "selection") {
        await mod.Haptics.selectionStart();
        return;
      }
      const styleMap = {
        light:  mod.ImpactStyle.Light,
        medium: mod.ImpactStyle.Medium,
        heavy:  mod.ImpactStyle.Heavy,
      } as const;
      await mod.Haptics.impact({ style: styleMap[intensity] });
      return;
    } catch {
      /* fall through to web */
    }
  }
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    const ms = intensity === "heavy" ? 18 : intensity === "medium" ? 10 : 6;
    try { navigator.vibrate?.(ms); } catch { /* ignore */ }
  }
}

export interface PositionResult {
  lat: number;
  lng: number;
  accuracy: number;
  /** Ms epoch */
  at: number;
}

/** One-shot location lookup. Uses Capacitor Geolocation on native (with the
 *  proper Info.plist / Manifest permissions configured), `navigator.geolocation`
 *  on the web. */
export async function getCurrentPosition(timeoutMs = 10000): Promise<PositionResult> {
  if (isNative()) {
    try {
      const mod = await import("@capacitor/geolocation");
      const pos = await mod.Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: timeoutMs,
      });
      return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: pos.timestamp,
      };
    } catch (e) {
      throw e instanceof Error ? e : new Error("Native geolocation failed");
    }
  }
  return new Promise<PositionResult>((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: pos.timestamp,
      }),
      (err) => reject(new Error(err.message)),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  });
}

/** Configure the native status bar (color, light/dark icons). Safe no-op on
 *  the web. Call from a top-level effect after the user's theme resolves. */
export async function configureStatusBar(opts: {
  style?: "light" | "dark";
  backgroundColor?: string;
}): Promise<void> {
  if (!isNative()) return;
  try {
    const mod = await import("@capacitor/status-bar");
    if (opts.style) {
      await mod.StatusBar.setStyle({
        style: opts.style === "dark" ? mod.Style.Dark : mod.Style.Light,
      });
    }
    if (opts.backgroundColor && platform() === "android") {
      await mod.StatusBar.setBackgroundColor({ color: opts.backgroundColor });
    }
  } catch {
    /* plugin not available */
  }
}

/** Wire native back-button (Android) + app-resume hooks. Call once at app
 *  bootstrap; the returned function unsubscribes. Web → no-op. */
export async function wireNativeAppEvents(handlers: {
  onBack?: () => boolean | void;
  onResume?: () => void;
}): Promise<() => void> {
  if (!isNative()) return () => {};
  try {
    const mod = await import("@capacitor/app");
    const subs: { remove: () => Promise<void> }[] = [];
    if (handlers.onBack) {
      const sub = await mod.App.addListener("backButton", () => {
        const consumed = handlers.onBack?.();
        if (!consumed) {
          mod.App.exitApp();
        }
      });
      subs.push(sub);
    }
    if (handlers.onResume) {
      const sub = await mod.App.addListener("appStateChange", (state: { isActive: boolean }) => {
        if (state.isActive) handlers.onResume?.();
      });
      subs.push(sub);
    }
    return () => {
      subs.forEach((s) => { void s.remove(); });
    };
  } catch {
    return () => {};
  }
}
