"use client";

/** "Share my live ETA" floating pill — only visible during an active
 *  trip. Three states:
 *
 *    1. idle    — single tap opens the share dialog
 *    2. sharing — pulsing dot, "stop" affordance, link copy/share again
 *    3. ended   — auto-collapses; reset to idle when the next trip starts
 *
 *  This is *separate* from the static `/share/trip` snapshot link
 *  (which serializes the full route polyline as a URL token). Live
 *  share continuously publishes the user's position to Firestore so
 *  recipients can watch them arrive.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Radio, Copy, Check, X, Share2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { isFirebaseConfigured } from "@/lib/firebase";
import { startLiveShare, type LiveShareHandle } from "@/lib/live-share";

interface Props {
  /** Required for sharing — anonymous users can't write to Firestore
   *  per security rules. We still render the pill so it can show a
   *  "sign in to share" message. */
  active: boolean;
  userLocation: { lat: number; lng: number } | null;
  userHeading: number | null;
  /** 0..1 along-route progress for the recipient's UI. */
  progressPct: number;
  /** Speed in m/s — used with `remainingKm` to estimate ETA. Optional;
   *  if missing we publish `etaAt: null` and recipients show "ETA
   *  unknown". */
  speedMps: number | null;
  totalDistanceKm: number;
  /** Destination for the recipient's map marker. */
  dest: { lat: number; lng: number; name: string } | null;
  /** ORS profile string — drives the recipient's mode icon. */
  mode: string | null;
}

export default function LiveSharePill({
  active, userLocation, userHeading, progressPct,
  speedMps, totalDistanceKm, dest, mode,
}: Props) {
  const { user } = useAuth();
  const [handle, setHandle] = useState<LiveShareHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Always-fresh refs so the periodic publisher inside the lib doesn't
  // capture stale snapshots.
  const handleRef = useRef<LiveShareHandle | null>(null);
  useEffect(() => { handleRef.current = handle; }, [handle]);

  // Push position/ETA updates to the live doc on every render where
  // we have a handle. The lib coalesces tiny moves and rides a 15s
  // timer so this isn't expensive.
  useEffect(() => {
    if (!handleRef.current || !userLocation || !dest) return;
    const remainingKm = Math.max(0, totalDistanceKm * (1 - Math.max(0, Math.min(1, progressPct))));
    let etaAt: number | null = null;
    if (speedMps && speedMps > 0.5) {
      // Cap effective speed so a momentary stop doesn't blow up the ETA.
      const speedKmh = Math.min(speedMps * 3.6, 200);
      const hours = remainingKm / speedKmh;
      etaAt = Date.now() + hours * 3_600_000;
    }
    void handleRef.current.update({
      position: userLocation,
      heading: userHeading,
      etaAt,
      progressPct: Math.max(0, Math.min(1, progressPct)),
    });
  }, [userLocation, userHeading, progressPct, totalDistanceKm, speedMps, dest]);

  // Auto-tear-down if the trip ends.
  useEffect(() => {
    if (active) return;
    if (!handleRef.current) return;
    void handleRef.current.stop();
    setHandle(null);
    setOpen(false);
  }, [active]);

  // Best-effort cleanup if the user closes the tab mid-share.
  useEffect(() => {
    const onPagehide = () => {
      if (handleRef.current) void handleRef.current.stop();
    };
    window.addEventListener("pagehide", onPagehide);
    return () => window.removeEventListener("pagehide", onPagehide);
  }, []);

  const handleStart = useCallback(async () => {
    if (busy || !user || !userLocation || !dest || !isFirebaseConfigured()) return;
    setBusy(true);
    setError(null);
    try {
      const h = await startLiveShare({
        position: userLocation,
        heading: userHeading,
        etaAt: null,
        progressPct,
        mode: mode || "driving-car",
        dest,
        ownerUid: user.uid,
        ownerName: user.displayName || null,
      });
      setHandle(h);
      // Try the native share sheet first — it's the right UX on mobile.
      // Fall back to clipboard on desktop.
      if (typeof navigator !== "undefined" && navigator.share) {
        try {
          await navigator.share({
            title: `Live ETA — heading to ${dest.name}`,
            text: `Watch me arrive: ${h.url}`,
            url: h.url,
          });
        } catch {
          // User cancelled the share sheet — leave the pill open so
          // they can try again with copy.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start sharing");
    } finally {
      setBusy(false);
    }
  }, [busy, user, userLocation, userHeading, progressPct, mode, dest]);

  const handleStop = useCallback(async () => {
    if (!handle) return;
    setBusy(true);
    try {
      await handle.stop();
    } finally {
      setHandle(null);
      setBusy(false);
      setOpen(false);
    }
  }, [handle]);

  const handleCopy = useCallback(async () => {
    if (!handle) return;
    try {
      await navigator.clipboard.writeText(handle.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied — show the URL inline so the user can long-press.
      setError("Copy blocked — long-press the link to share manually.");
    }
  }, [handle]);

  if (!active) return null;
  if (!isFirebaseConfigured()) return null;

  const sharing = handle !== null;

  return (
    <div className="relative pointer-events-auto">
      <button
        onClick={() => {
          if (sharing) {
            setOpen((v) => !v);
            return;
          }
          if (!user) {
            setError("Sign in to share your live ETA.");
            setOpen(true);
            return;
          }
          void handleStart();
        }}
        disabled={busy}
        className="flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium shadow-lg transition-all active:scale-95 disabled:opacity-60"
        style={{
          background: sharing ? "rgba(239,68,68,0.15)" : "var(--pill-bg, rgba(255,255,255,0.08))",
          border: `1px solid ${sharing ? "rgba(239,68,68,0.4)" : "var(--pill-border, rgba(255,255,255,0.1))"}`,
          color: sharing ? "#ef4444" : "var(--pill-text, #ccc)",
        }}
        title={sharing ? "You're sharing your live ETA" : "Share live ETA with someone"}
        aria-label={sharing ? "Stop sharing live ETA" : "Share live ETA"}
      >
        <Radio
          className={`w-3.5 h-3.5 ${sharing ? "live-share-pulse" : ""}`}
        />
        {sharing ? "Sharing" : "Share ETA"}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 mt-2 w-72 rounded-xl shadow-2xl backdrop-blur-md overflow-hidden z-[1095]"
            style={{
              background: "var(--panel-bg)",
              border: "1px solid var(--panel-border)",
            }}
          >
            {sharing && handle ? (
              <>
                <div className="px-3 py-2.5" style={{ borderBottom: "1px solid var(--panel-border)" }}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "var(--panel-text-muted)" }}>
                    Live share active
                  </p>
                  <p className="text-xs break-all font-mono" style={{ color: "var(--panel-text)" }}>
                    {handle.url}
                  </p>
                </div>
                <div className="p-1.5 flex items-center gap-1">
                  <button
                    onClick={handleCopy}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium hover:bg-white/5 transition-colors"
                    style={{ color: "var(--panel-text)" }}
                  >
                    {copied ? (
                      <><Check className="w-3.5 h-3.5 text-emerald-500" /> Copied</>
                    ) : (
                      <><Copy className="w-3.5 h-3.5" /> Copy link</>
                    )}
                  </button>
                  {typeof navigator !== "undefined" && navigator.share && (
                    <button
                      onClick={() => {
                        navigator.share?.({
                          title: `Live ETA${dest ? ` — heading to ${dest.name}` : ""}`,
                          text: `Watch me arrive: ${handle.url}`,
                          url: handle.url,
                        }).catch(() => { /* user cancelled */ });
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium hover:bg-white/5 transition-colors"
                      style={{ color: "var(--panel-text)" }}
                      aria-label="Share via system sheet"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={handleStop}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                    style={{
                      background: "rgba(239,68,68,0.12)",
                      color: "#ef4444",
                    }}
                  >
                    <X className="w-3.5 h-3.5" /> Stop
                  </button>
                </div>
                <p className="px-3 pb-2 text-[10px] leading-snug" style={{ color: "var(--panel-text-muted)" }}>
                  Auto-expires after 4 hours. Anyone with this link can see your live position until you stop or arrive.
                </p>
              </>
            ) : (
              <div className="px-3 py-2.5">
                <p className="text-xs" style={{ color: "var(--panel-text)" }}>
                  {error || "Sign in to share your live ETA."}
                </p>
                <button
                  onClick={() => { setError(null); setOpen(false); }}
                  className="mt-2 px-2.5 py-1 rounded-lg text-[10px] font-medium hover:bg-white/5 transition-colors"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  Dismiss
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
