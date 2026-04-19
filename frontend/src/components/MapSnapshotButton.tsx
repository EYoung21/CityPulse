"use client";

import { useState } from "react";
import { Camera, Loader2, Check, AlertCircle } from "lucide-react";
import { captureMapSnapshot, shareSnapshot } from "@/lib/map-snapshot";

interface Props {
  /** Resolves the DOM element to rasterize. We pass a getter (not a
   *  ref directly) so the button works whether the map element is
   *  conditionally rendered or shifts position over time. */
  getMapElement: () => HTMLElement | null;
  /** Optional override for the watermark caption (e.g. include trip
   *  metadata when an active trip is in progress). */
  caption?: string;
  /** Visual variant: "icon" renders a 40x40 floating button; "row"
   *  renders an inline list-item style suitable for menus. */
  variant?: "icon" | "row";
  className?: string;
}

/** One-tap share/download button for the current map view. Captures
 *  the supplied DOM subtree, watermarks the result, and routes to the
 *  Web Share API on mobile or a download fallback on desktop. The
 *  capture runs entirely client-side — there's no server upload. */
export default function MapSnapshotButton({
  getMapElement,
  caption,
  variant = "icon",
  className = "",
}: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"ok" | "warn" | "err" | null>(null);

  const handleClick = async () => {
    const el = getMapElement();
    if (!el) {
      setStatus("err");
      setTimeout(() => setStatus(null), 2400);
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const result = await captureMapSnapshot({
        element: el,
        caption: caption ?? "PhillyPulse · safe routes",
      });
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      await shareSnapshot(result.blob, `phillypulse-${stamp}.png`);
      setStatus(result.tilesMissing ? "warn" : "ok");
    } catch {
      setStatus("err");
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(null), 2800);
    }
  };

  if (variant === "row") {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className={`w-full flex items-center justify-between px-2 py-2 rounded-lg transition-colors text-xs disabled:opacity-50 ${className}`}
        style={{ color: "var(--panel-text-secondary)" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        title="Capture and share what's currently on screen"
      >
        <span className="flex items-center gap-2">
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : status === "ok" ? (
            <Check className="w-3.5 h-3.5" style={{ color: "#22c55e" }} />
          ) : status === "warn" || status === "err" ? (
            <AlertCircle className="w-3.5 h-3.5" style={{ color: "#f59e0b" }} />
          ) : (
            <Camera className="w-3.5 h-3.5" />
          )}
          <span>
            {busy
              ? "Capturing…"
              : status === "ok"
                ? "Shared"
                : status === "warn"
                  ? "Captured (tiles missing)"
                  : status === "err"
                    ? "Couldn't capture"
                    : "Share map snapshot"}
          </span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className={`w-10 h-10 flex items-center justify-center rounded-lg backdrop-blur-md shadow-lg transition-colors active:scale-95 disabled:opacity-50 ${className}`}
      style={{
        background: "var(--pill-bg)",
        border: "1px solid var(--pill-border)",
        color:
          status === "ok"
            ? "#22c55e"
            : status === "warn" || status === "err"
              ? "#f59e0b"
              : "var(--pill-text)",
      }}
      title="Share map snapshot"
      aria-label="Share map snapshot"
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : status === "ok" ? (
        <Check className="w-4 h-4" />
      ) : (
        <Camera className="w-4 h-4" />
      )}
    </button>
  );
}
