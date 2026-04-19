"use client";

/** Live ETA sharing.
 *
 *  Sender publishes their position, destination, ETA, and progress to
 *  a public Firestore document at `liveTrips/{shareId}`. Recipients
 *  open a `/share/live?id={shareId}` URL and watch the sender move on
 *  a map until they arrive (or until the share expires after 4h).
 *
 *  Why Firestore (and not, say, a websocket service):
 *    - We're already paying for it; no extra infra
 *    - Realtime listeners on a single doc are cheap (~one read per
 *      update on the recipient side)
 *    - 4h TTL via Firestore's built-in TTL policy keeps the
 *      collection bounded without a cron
 *
 *  Why a 12-char base32 ID is acceptable as the only auth:
 *    - 32^12 ≈ 1.15e18 IDs — guessing one is statistically infeasible
 *      even with sustained brute-force
 *    - Recipients have to be sent the link out-of-band (SMS, etc.)
 *    - We don't store anything personally identifiable beyond the
 *      destination's display name
 *
 *  Trade-offs:
 *    - Anyone with the link can view forever-until-expiry. We could
 *      add a recipient-side passcode but it'd add friction for a
 *      feature most users will use briefly. Stop-share is one click.
 *    - Updates are throttled to one every 15s on the sender side to
 *      keep Firestore writes (and battery) cheap. Recipients see
 *      smooth interpolation client-side instead of true realtime.
 */

import {
  doc,
  setDoc,
  updateDoc,
  serverTimestamp,
  getFirestore,
  type FieldValue,
} from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";

export interface LiveTripDestination {
  lat: number;
  lng: number;
  name: string;
}

export interface LiveTripDoc {
  /** Firestore-managed timestamp; client sees a Timestamp or null
   *  during the write round-trip. */
  createdAt: unknown;
  /** Hard expiry — Firestore's TTL policy nukes the doc here. */
  expiresAt: Date;
  /** Owner UID — used by security rules to gate writes to the
   *  creator. Recipients don't need this. */
  ownerUid: string;
  /** Optional public-facing nickname for the sender. Recipients see
   *  this above the ETA banner. */
  ownerName: string | null;
  dest: LiveTripDestination;
  position: { lat: number; lng: number; heading: number | null };
  /** Best-effort ETA as ms-since-epoch — we update on each tick. */
  etaAt: number | null;
  /** 0..1 along-route progress for a smoother recipient UI. */
  progressPct: number;
  /** ORS profile string — used by the recipient to pick a
   *  car/bike/walk icon. */
  mode: string;
  /** Set to true on graceful end so the recipient can show "Arrived"
   *  instead of just letting the doc go stale. */
  ended: boolean;
}

const SHARE_TTL_MS = 4 * 60 * 60 * 1000; // 4h
const UPDATE_INTERVAL_MS = 15_000;

/** 12-char base32 (Crockford) ID — readable, double-click-selectable,
 *  and avoids confusable characters (0/O, 1/I/L). 60 bits of entropy. */
function generateShareId(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = new Uint8Array(12);
  if (typeof window !== "undefined" && window.crypto) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 12; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < 12; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

/** Round a float to 5 decimals (~1m) so we don't churn Firestore
 *  writes on micro-jitter. */
function trim5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

export interface LiveShareSnapshot {
  position: { lat: number; lng: number };
  heading: number | null;
  etaAt: number | null;
  progressPct: number;
  mode: string;
  dest: LiveTripDestination;
  ownerUid: string;
  ownerName?: string | null;
}

export interface LiveShareHandle {
  /** Random 12-char ID also embedded in the share URL. */
  shareId: string;
  /** Full share URL, ready to drop into navigator.share / clipboard. */
  url: string;
  /** Push a fresh snapshot now (also runs on a 15s interval until stop). */
  update: (snap: Partial<LiveShareSnapshot>) => Promise<void>;
  /** Mark `ended: true` so recipients see an "Arrived" state, then
   *  tear down the interval. The doc itself stays around until TTL. */
  stop: () => Promise<void>;
}

/** Begin publishing a live trip. The caller owns the snapshot — wire
 *  it to whatever per-tick state the trip view holds, and call
 *  `update()` whenever the user's position / ETA changes. */
export async function startLiveShare(initial: LiveShareSnapshot): Promise<LiveShareHandle> {
  if (!isFirebaseConfigured()) {
    throw new Error("Firebase isn't configured — live share unavailable.");
  }
  const db = getFirestore(getFirebaseApp());
  const shareId = generateShareId();
  const ref = doc(db, "liveTrips", shareId);
  const now = Date.now();
  const data: Omit<LiveTripDoc, "createdAt"> & { createdAt: FieldValue } = {
    createdAt: serverTimestamp(),
    expiresAt: new Date(now + SHARE_TTL_MS),
    ownerUid: initial.ownerUid,
    ownerName: initial.ownerName ?? null,
    dest: initial.dest,
    position: {
      lat: trim5(initial.position.lat),
      lng: trim5(initial.position.lng),
      heading: initial.heading ?? null,
    },
    etaAt: initial.etaAt ?? null,
    progressPct: initial.progressPct,
    mode: initial.mode,
    ended: false,
  };
  await setDoc(ref, data);

  let last: LiveShareSnapshot = { ...initial };
  let intervalId: number | undefined;
  let stopped = false;

  const flush = async () => {
    if (stopped) return;
    try {
      await updateDoc(ref, {
        position: {
          lat: trim5(last.position.lat),
          lng: trim5(last.position.lng),
          heading: last.heading ?? null,
        },
        etaAt: last.etaAt ?? null,
        progressPct: last.progressPct,
      });
    } catch (err) {
      // Don't blow up the whole trip just because Firestore had a
      // hiccup — the next tick will retry.
      console.warn("live-share flush failed:", err);
    }
  };

  // Periodic push so a stationary recipient still sees a "still
  // moving" heartbeat rather than a frozen marker.
  if (typeof window !== "undefined") {
    intervalId = window.setInterval(() => { void flush(); }, UPDATE_INTERVAL_MS);
  }

  const url = typeof window !== "undefined"
    ? `${window.location.origin}/share/live?id=${encodeURIComponent(shareId)}`
    : `/share/live?id=${encodeURIComponent(shareId)}`;

  return {
    shareId,
    url,
    update: async (snap) => {
      last = { ...last, ...snap };
      // Coalesce: only fire an immediate write if the position has
      // moved by more than ~5m. ETA-only updates ride the 15s timer
      // so we're not paying for cosmetic changes.
      if (snap.position) {
        const dLat = Math.abs(snap.position.lat - last.position.lat);
        const dLng = Math.abs(snap.position.lng - last.position.lng);
        if (dLat > 4e-5 || dLng > 4e-5) {
          await flush();
        }
      }
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (intervalId) window.clearInterval(intervalId);
      try {
        await updateDoc(ref, { ended: true });
      } catch (err) {
        console.warn("live-share stop failed:", err);
      }
    },
  };
}
