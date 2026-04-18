"use client";

import { useEffect } from "react";
import { configureStatusBar, isNative, wireNativeAppEvents } from "@/lib/native";

/** Mounted once at the root of the app. Configures the native status bar
 *  (when running inside the Capacitor shell) and wires the Android back
 *  button to dismiss any open overlay before exiting. No-op on web. */
export default function NativeBoot() {
  useEffect(() => {
    if (!isNative()) return;
    let cleanup: (() => void) | undefined;
    void configureStatusBar({ style: "dark", backgroundColor: "#0a0a14" });
    void wireNativeAppEvents({
      onBack: () => {
        // Try to close the topmost overlay first by dispatching a custom
        // event the page listens for. Returning true tells `native.ts` not
        // to exit the app.
        const handled = (() => {
          const ev = new CustomEvent("pp:native-back");
          let consumed = false;
          ev.preventDefault = () => { consumed = true; };
          window.dispatchEvent(ev);
          return consumed;
        })();
        return handled;
      },
    }).then((unsub) => {
      cleanup = unsub;
    });
    return () => {
      cleanup?.();
    };
  }, []);
  return null;
}
