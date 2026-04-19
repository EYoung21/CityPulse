"use client";

/** Sync the user's predicted commute to Firestore so the FastAPI
 *  cron can fire push notifications even when the tab is fully
 *  closed.
 *
 *  Trade-offs vs. the existing client-only flow:
 *    - The schedule **only** syncs when the user has both push
 *      notifications enabled AND commute notifications opted in;
 *      otherwise we'd be uploading a behavioural pattern (commute
 *      destination + time) for no benefit.
 *    - The synced doc is intentionally tiny (no raw trip history,
 *      no individual trip timestamps) — just the prediction the
 *      user already sees in-app.
 *    - We dedupe by `bucketKey` per user. A user with multiple
 *      patterns (e.g. weekday work commute + weekend gym run) ends
 *      up with two docs, which is exactly what we want — each fires
 *      independently from the cron.
 *    - The backend tracks `lastFiredYmd` server-side so the same
 *      schedule never fires twice on the same calendar day, even
 *      across cron invocations and app restarts.
 *
 *  We don't sync the legacy `pp:commute-notify-fired-v1` localStorage
 *  set; the server's `lastFiredYmd` is authoritative for closed-tab
 *  pushes, and the client still uses its own local set to dedupe
 *  in-tab firings (so the user doesn't see the same nudge twice if
 *  both the tab and the server-side fan-out fire within seconds of
 *  each other; the OS notification `tag` matches in both paths so
 *  the second one replaces rather than stacks). */

import { deleteDoc, doc, getFirestore, setDoc } from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import type { CommutePrediction } from "@/lib/commute-patterns";

const COLLECTION = "commuteSchedules";

interface ScheduleDoc {
  uid: string;
  bucketKey: string;
  destLat: number;
  destLng: number;
  destLabel: string;
  matchedCategory: "home" | "work" | null;
  typicalDepartureMinute: number;
  typicalDurationMin: number;
  isWeekend: boolean;
  confidence: number;
  tz: string;
  updatedAt: number;
}

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function scheduleId(uid: string, bucketKey: string): string {
  // Sanitize bucketKey to be Firestore-doc-id safe; predictor's
  // current bucket keys look like "wd:14" or "we:7" so this is
  // mostly defensive against future format changes.
  const safe = bucketKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${uid}_${safe}`;
}

/** Push (or refresh) the schedule for one prediction. Idempotent;
 *  callers can invoke this on every prediction tick — the document
 *  size is small (<300 B) so the write cost is negligible. */
export async function upsertCommuteSchedule(
  uid: string,
  prediction: CommutePrediction
): Promise<void> {
  if (!isFirebaseConfigured()) return;
  const db = getFirestore(getFirebaseApp());
  const id = scheduleId(uid, prediction.bucketKey);
  const isWeekend = prediction.bucketKey.startsWith("we:");
  const payload: ScheduleDoc = {
    uid,
    bucketKey: prediction.bucketKey,
    destLat: prediction.destLat,
    destLng: prediction.destLng,
    destLabel: prediction.destLabel,
    matchedCategory: prediction.matchedCategory,
    typicalDepartureMinute: prediction.typicalDepartureMinute,
    typicalDurationMin: prediction.typicalDurationMin,
    isWeekend,
    confidence: prediction.confidence,
    tz: detectTimezone(),
    updatedAt: Date.now(),
  };
  // setDoc with merge:false so an updated prediction (e.g. user's
  // commute time shifted by 15 min after a job change) overwrites
  // the previous payload cleanly, including any stale fields.
  await setDoc(doc(db, COLLECTION, id), payload);
}

/** Delete a single schedule by bucket key — used when the user
 *  dismisses a prediction or it falls below the confidence floor. */
export async function deleteCommuteSchedule(
  uid: string,
  bucketKey: string
): Promise<void> {
  if (!isFirebaseConfigured()) return;
  const db = getFirestore(getFirebaseApp());
  await deleteDoc(doc(db, COLLECTION, scheduleId(uid, bucketKey)));
}
