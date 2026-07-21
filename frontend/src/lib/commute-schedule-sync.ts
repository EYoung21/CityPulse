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

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  query,
  setDoc,
  where,
} from "firebase/firestore";
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

function isValidPrediction(prediction: CommutePrediction): boolean {
  return (
    prediction.bucketKey.length > 0 &&
    prediction.bucketKey.length <= 80 &&
    Number.isFinite(prediction.destLat) &&
    prediction.destLat >= -90 &&
    prediction.destLat <= 90 &&
    Number.isFinite(prediction.destLng) &&
    prediction.destLng >= -180 &&
    prediction.destLng <= 180 &&
    prediction.destLabel.trim().length > 0 &&
    prediction.destLabel.length <= 160 &&
    Number.isFinite(prediction.typicalDepartureMinute) &&
    prediction.typicalDepartureMinute >= 0 &&
    prediction.typicalDepartureMinute < 1440 &&
    Number.isFinite(prediction.typicalDurationMin) &&
    prediction.typicalDurationMin > 0 &&
    prediction.typicalDurationMin <= 1440 &&
    Number.isFinite(prediction.confidence) &&
    prediction.confidence >= 0 &&
    prediction.confidence <= 1
  );
}

/** Push (or refresh) the schedule for one prediction. Idempotent;
 *  callers can invoke this on every prediction tick — the document
 *  size is small (<300 B) so the write cost is negligible. */
export async function upsertCommuteSchedule(
  uid: string,
  prediction: CommutePrediction
): Promise<void> {
  if (!isFirebaseConfigured()) return;
  if (!uid || uid.length > 128 || !isValidPrediction(prediction)) {
    throw new Error("Invalid commute schedule");
  }
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
  // Preserve the server-owned lastFired* fields. Replacing the whole
  // document here used to erase the daily notification dedupe marker,
  // allowing the same commute nudge to fire repeatedly after a refresh.
  await setDoc(doc(db, COLLECTION, id), payload, { merge: true });
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

/** Snapshot of one synced schedule, returned by `listCommuteSchedules`
 *  for the settings UI. We expose only the fields useful for a
 *  human-readable list — the full Firestore doc has more bookkeeping
 *  the user doesn't need to see. */
export interface CommuteScheduleSummary {
  /** Firestore doc id; pass to `deleteCommuteScheduleById`. */
  id: string;
  bucketKey: string;
  destLabel: string;
  matchedCategory: "home" | "work" | null;
  /** 0..1439 in the schedule's stored timezone. */
  typicalDepartureMinute: number;
  typicalDurationMin: number;
  isWeekend: boolean;
  confidence: number;
  tz: string;
  updatedAt: number;
  /** Server-stamped after a successful push fan-out. May be empty. */
  lastFiredYmd?: string;
}

export async function listCommuteSchedules(uid: string): Promise<CommuteScheduleSummary[]> {
  if (!isFirebaseConfigured()) return [];
  const db = getFirestore(getFirebaseApp());
  // Firestore rules already restrict reads to docs whose `uid`
  // matches the caller, but we filter explicitly so the query is
  // also indexed and we don't accidentally pull every doc client-
  // side if a future rules tweak loosens the read scope.
  const q = query(collection(db, COLLECTION), where("uid", "==", uid));
  const snap = await getDocs(q);
  const out: CommuteScheduleSummary[] = [];
  snap.forEach((d) => {
    const v = d.data() as Record<string, unknown>;
    out.push({
      id: d.id,
      bucketKey: String(v.bucketKey ?? ""),
      destLabel: String(v.destLabel ?? "your destination"),
      matchedCategory: (v.matchedCategory as "home" | "work" | null) ?? null,
      typicalDepartureMinute: Number(v.typicalDepartureMinute ?? 0),
      typicalDurationMin: Number(v.typicalDurationMin ?? 0),
      isWeekend: Boolean(v.isWeekend),
      confidence: Number(v.confidence ?? 0),
      tz: String(v.tz ?? ""),
      updatedAt: Number(v.updatedAt ?? 0),
      lastFiredYmd: typeof v.lastFiredYmd === "string" ? v.lastFiredYmd : undefined,
    });
  });
  // Sort by typical departure minute so weekday-morning routines
  // group together and the list reads top-to-bottom across the day.
  out.sort((a, b) => a.typicalDepartureMinute - b.typicalDepartureMinute);
  return out;
}

export async function deleteCommuteScheduleById(scheduleId: string): Promise<void> {
  if (!isFirebaseConfigured()) return;
  const db = getFirestore(getFirebaseApp());
  await deleteDoc(doc(db, COLLECTION, scheduleId));
}

/** Format a minute-of-day as a 12-hour locale string. */
export function formatScheduleTime(minute: number): string {
  const d = new Date();
  d.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
