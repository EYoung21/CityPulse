"use client";

/** Recipient-side view for `/share/live?id=<shareId>`. Subscribes to
 *  the Firestore `liveTrips/{shareId}` doc and renders a Leaflet map
 *  with the sender's pulsing position marker, destination flag, and
 *  a banner showing the live ETA.
 *
 *  Failure modes the UI handles:
 *    - Doc doesn't exist → "Link expired or invalid"
 *    - Doc exists but `expiresAt` has passed → "Share has expired"
 *    - `ended: true` → "Arrived" banner with the destination
 *    - Position hasn't updated in >2 minutes → "Connection lost" hint
 *      (the sender may be in a tunnel, or stopped sharing)
 */

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { doc, getFirestore, onSnapshot, type FirestoreError } from "firebase/firestore";
import { Radio, Flag, Loader2 } from "lucide-react";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import type { LiveTripDoc } from "@/lib/live-share";
import {
  isLiveShareId,
  liveShareExpiryMillis,
  parseLiveTripDoc,
} from "@/lib/live-share-validation";

// Leaflet is browser-only.
const SimpleLiveMap = dynamic(() => import("./SimpleLiveMap"), { ssr: false });

interface Props {
  shareId: string;
}

type FetchState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; doc: LiveTripDoc; updatedAt: number };

function formatEta(etaAt: number | null, now: number): { line1: string; line2: string } {
  if (!etaAt) return { line1: "ETA unknown", line2: "Waiting for movement…" };
  const remainingMs = etaAt - now;
  if (remainingMs <= 0) return { line1: "Arriving now", line2: "" };
  const mins = Math.round(remainingMs / 60_000);
  const arriveTime = new Date(etaAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (mins < 60) {
    return { line1: `${mins} min`, line2: `Arrives ${arriveTime}` };
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return { line1: `${h}h ${m}m`, line2: `Arrives ${arriveTime}` };
}

export default function LiveTripView({ shareId }: Props) {
  const [state, setState] = useState<FetchState>(() =>
    !isLiveShareId(shareId)
      ? { kind: "error", message: "This share link is invalid or has expired." }
      : isFirebaseConfigured()
        ? { kind: "loading" }
        : { kind: "error", message: "Live share isn't available in this environment." }
  );
  const [now, setNow] = useState(Date.now);
  const [lastWriteAt, setLastWriteAt] = useState(now);

  // Subscribe to the live doc.
  useEffect(() => {
    if (!isLiveShareId(shareId) || !isFirebaseConfigured()) {
      return;
    }
    const db = getFirestore(getFirebaseApp());
    const ref = doc(db, "liveTrips", shareId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setState({ kind: "error", message: "This share link is invalid or has expired." });
          return;
        }
        const data = parseLiveTripDoc(snap.data());
        if (!data) {
          setState({ kind: "error", message: "This live share contains invalid data." });
          return;
        }
        // Guard against expired shares — the TTL policy may not have
        // run yet, but we should still hide stale data.
        const expiresMs = liveShareExpiryMillis(data.expiresAt);
        if (expiresMs === null || Date.now() > expiresMs) {
          setState({ kind: "error", message: "This share link has expired." });
          return;
        }
        const updatedAt = Date.now();
        setLastWriteAt(updatedAt);
        setState({ kind: "ok", doc: data, updatedAt });
      },
      (err: FirestoreError) => {
        setState({ kind: "error", message: err.message || "Couldn't load this share." });
      }
    );
    return () => unsub();
  }, [shareId]);

  // Tick once per second so the ETA countdown stays fresh and the
  // "no update for 2 min" banner can light up without a new doc write.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (state.kind === "loading") {
    return (
      <main
        className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100"
        aria-busy="true"
      >
        <h1 className="sr-only">Loading live share</h1>
        <Loader2 className="w-6 h-6 animate-spin text-blue-400" aria-hidden="true" />
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
        <div className="max-w-md text-center">
          <p className="text-xs uppercase tracking-widest text-slate-500">PhillyPulse</p>
          <h1 className="text-2xl font-bold mt-2">{state.message}</h1>
          <p className="text-sm text-slate-400 mt-3">
            Live shares auto-expire after 4 hours. Ask the sender for a fresh link.
          </p>
          <Link href="/" className="inline-block mt-6 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold">
            Open PhillyPulse
          </Link>
        </div>
      </main>
    );
  }

  const d = state.doc;
  const eta = formatEta(d.etaAt, now);
  const ageMs = now - lastWriteAt;
  const stale = ageMs > 2 * 60_000 && !d.ended;

  return (
    <main className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <SimpleLiveMap
        position={d.position}
        dest={d.dest}
      />
      <div className="absolute inset-x-0 top-0 z-[1100] p-3 pointer-events-none">
        <div className="max-w-md mx-auto pointer-events-auto rounded-2xl shadow-2xl backdrop-blur-xl overflow-hidden"
          style={{
            background: "rgba(15, 23, 42, 0.85)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div className="px-4 py-3 flex items-start gap-3">
            <div
              className={`w-10 h-10 shrink-0 rounded-xl flex items-center justify-center ${d.ended ? "" : "live-share-pulse"}`}
              style={{
                background: d.ended ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.18)",
                color: d.ended ? "#22c55e" : "#ef4444",
              }}
            >
              {d.ended ? <Flag className="w-5 h-5" /> : <Radio className="w-5 h-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wider text-slate-400">
                {d.ownerName ? `${d.ownerName}'s ETA` : "Live ETA"}
              </p>
              <h1 className="text-2xl font-bold mt-0.5 leading-none">
                {d.ended ? "Arrived" : eta.line1}
              </h1>
              {!d.ended && eta.line2 && (
                <p className="text-xs text-slate-400 mt-1">{eta.line2}</p>
              )}
              <p className="text-xs mt-2 text-slate-300 truncate">
                <Flag className="inline w-3 h-3 mr-1 text-slate-500" />
                {d.dest.name}
              </p>
            </div>
          </div>
          {stale && (
            <div className="px-4 py-2 text-[10px] flex items-center gap-1.5 border-t border-white/5 text-amber-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              No update in 2+ min — the sender may be in a low-signal area.
            </div>
          )}
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 z-[1100] p-3 pointer-events-none">
        <div className="max-w-md mx-auto text-center">
          <Link
            href="/"
            className="pointer-events-auto inline-block px-4 py-2 rounded-full text-xs font-medium backdrop-blur-md"
            style={{
              background: "rgba(15, 23, 42, 0.85)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#cbd5e1",
            }}
          >
            Open PhillyPulse
          </Link>
        </div>
      </div>
    </main>
  );
}
