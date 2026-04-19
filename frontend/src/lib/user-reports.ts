"use client";

/** Crowdsourced safety reports.
 *
 *  Lets signed-in users drop "I see X here" pins that ride alongside
 *  the official scanner-derived incidents. Reports are conceptually
 *  the same as incidents (geo-tagged, time-stamped, severity-tagged)
 *  so the easiest way to surface them is to mint Incident-shaped
 *  records on the client and merge into the existing incidents
 *  array. That gives us free re-use of:
 *    - the marker layer + clustering
 *    - off-screen alert chips + on-route ahead-of alerts
 *    - the alerts inbox
 *    - the safety score card area scoring
 *
 *  We use a `user_report_*` severity_category prefix so consumers can
 *  spot crowdsourced rows when they need to (e.g. to badge them in
 *  the UI, or omit them from analytics that should only count
 *  authoritative incidents).
 *
 *  Anti-spam:
 *    - Only signed-in (non-anonymous) users can submit. Anonymous
 *      sign-ins still get to *read* reports.
 *    - Client-side rate limit: one submission per 60s per user, plus
 *      a 25m radius dedupe (you can't drop two of the same category
 *      within 25m of each other inside an hour).
 *    - 4h TTL — older reports are filtered client-side. The Firestore
 *      collection should also have a TTL policy on `expiresAt` so
 *      docs don't pile up forever.
 *    - Server-side rules enforce schema + ownership; see
 *      firestore.rules.
 *
 *  Schema (Firestore `userReports/{id}`):
 *    - city: string                    — pulse-city slug
 *    - lat / lng: number
 *    - category: UserReportCategory    — see USER_REPORT_CATEGORIES
 *    - note: string (≤140)             — optional freeform
 *    - ownerUid: string                — submitter
 *    - ownerName: string (≤60)         — display name snapshot for UI
 *    - createdAt: serverTimestamp
 *    - expiresAt: number               — millis epoch, owner+4h
 */

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  increment,
  limit as limitFn,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import type { Incident } from "@/lib/api";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { getCurrentCity } from "@/lib/pulse-cities";

const COLLECTION = "userReports";
const MAX_DOCS = 500;
const TTL_MS = 4 * 60 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const DUPE_RADIUS_M = 25;
const DUPE_WINDOW_MS = 60 * 60_000;
const NOTE_MAX = 140;
const RECENT_KEY = "pp:user-reports-recent-v1";

export type UserReportCategory =
  | "user_hazard"
  | "user_crash"
  | "user_police"
  | "user_disorder"
  | "user_other";

interface CategoryMeta {
  /** Short label for buttons / pills. */
  label: string;
  /** Single-sentence description for the report form. */
  hint: string;
  /** Maps to the underlying `severity_category` string used by
   *  alerts/inbox/heatmap. Each gets a corresponding entry in
   *  `lib/severity.ts` so it renders with sensible colours. */
  severity: UserReportCategory;
  /** Single-emoji glyph used in the inline form picker so the
   *  options scan quickly without needing per-icon imports. */
  glyph: string;
}

export const USER_REPORT_CATEGORIES: CategoryMeta[] = [
  { severity: "user_hazard",    label: "Hazard",          hint: "Debris, flooding, downed wire, road obstruction", glyph: "⚠" },
  { severity: "user_crash",     label: "Crash",           hint: "Vehicle collision, pedestrian struck",            glyph: "🚗" },
  { severity: "user_police",    label: "Police activity", hint: "Heavy police presence, road closure, response",   glyph: "🚓" },
  { severity: "user_disorder",  label: "Disorder",        hint: "Active conflict, suspicious activity",            glyph: "👀" },
  { severity: "user_other",     label: "Other",           hint: "Anything else worth flagging",                    glyph: "📍" },
];

export interface UserReport {
  id: string;
  lat: number;
  lng: number;
  category: UserReportCategory;
  note: string;
  ownerUid: string;
  ownerName: string;
  createdAtMs: number;
  expiresAtMs: number;
  /** Aggregated vote counts maintained by clients via the
   *  `voteOnUserReport` transaction. Default to 0 for legacy docs
   *  that pre-date the voting feature. */
  confirmCount: number;
  disputeCount: number;
}

/** Reports that drop below this net score are hidden client-side
 *  (and ideally cleaned up by a server function). Net score = confirms
 *  minus disputes. -3 was chosen so a single misclick doesn't bury a
 *  legit report, but a small cluster of disputes is enough to act. */
export const HIDE_THRESHOLD = -3;

interface NewUserReportInput {
  lat: number;
  lng: number;
  category: UserReportCategory;
  note?: string;
}

interface RecentSubmission {
  ts: number;
  category: UserReportCategory;
  lat: number;
  lng: number;
}

const R_KM = 6371;
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(sa)));
}

function loadRecentSubmissions(): RecentSubmission[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentSubmission[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - DUPE_WINDOW_MS;
    return parsed.filter((r) => r && typeof r.ts === "number" && r.ts >= cutoff);
  } catch {
    return [];
  }
}

function saveRecentSubmissions(rows: RecentSubmission[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(rows.slice(0, 20)));
  } catch { /* storage full — best effort */ }
}

/** Returns null if the submission can proceed, or a human-readable
 *  reason string the UI should surface to the user. Performs the
 *  client-side rate-limit + dedupe checks; the same logic should be
 *  enforced server-side by Firestore rules + a Cloud Function for
 *  multi-device users (rules can't see history without an auxiliary
 *  doc per user, which is overkill for v1). */
export function checkSubmissionAllowed(input: NewUserReportInput): string | null {
  const now = Date.now();
  const recent = loadRecentSubmissions();
  const lastTs = recent[0]?.ts ?? 0;
  if (now - lastTs < MIN_INTERVAL_MS) {
    const wait = Math.ceil((MIN_INTERVAL_MS - (now - lastTs)) / 1000);
    return `Wait ${wait}s between reports.`;
  }
  for (const r of recent) {
    if (r.category !== input.category) continue;
    const km = haversineKm({ lat: r.lat, lng: r.lng }, input);
    if (km * 1000 < DUPE_RADIUS_M) {
      return "You already reported this here. Tap the existing pin to remove or replace.";
    }
  }
  return null;
}

interface CurrentUserSnapshot {
  uid: string;
  isAnonymous: boolean;
  displayName: string | null;
  email: string | null;
}

/** Submit a user report. The caller passes the current user as a
 *  snapshot rather than us reaching into AuthContext directly, so
 *  this module stays React-free.
 *
 *  Throws on permission / network failures. Returns the new
 *  document ID on success. */
export async function submitUserReport(
  input: NewUserReportInput,
  user: CurrentUserSnapshot
): Promise<string> {
  if (!isFirebaseConfigured()) throw new Error("Sign in to submit reports.");
  if (user.isAnonymous) throw new Error("Sign in to submit reports.");

  const blocked = checkSubmissionAllowed(input);
  if (blocked) throw new Error(blocked);

  const note = (input.note ?? "").trim().slice(0, NOTE_MAX);
  const now = Date.now();
  const payload = {
    city: getCurrentCity().slug,
    lat: input.lat,
    lng: input.lng,
    category: input.category,
    note,
    ownerUid: user.uid,
    ownerName: (user.displayName || user.email || "Reporter").slice(0, 60),
    createdAt: serverTimestamp(),
    expiresAt: now + TTL_MS,
  };

  const db = getFirestore(getFirebaseApp());
  const ref = await addDoc(collection(db, COLLECTION), payload);

  const recent = loadRecentSubmissions();
  recent.unshift({ ts: now, category: input.category, lat: input.lat, lng: input.lng });
  saveRecentSubmissions(recent);

  return ref.id;
}

/** Owner-only deletion. Surfaced from the report's incident card so
 *  a reporter can cancel a misclick. */
export async function deleteUserReport(id: string): Promise<void> {
  if (!isFirebaseConfigured()) return;
  const db = getFirestore(getFirebaseApp());
  await deleteDoc(doc(db, COLLECTION, id));
}

function mapDoc(id: string, d: Record<string, unknown>): UserReport | null {
  const lat = typeof d.lat === "number" ? d.lat : null;
  const lng = typeof d.lng === "number" ? d.lng : null;
  if (lat === null || lng === null) return null;
  const category = String(d.category ?? "user_other") as UserReportCategory;
  const validCategory = USER_REPORT_CATEGORIES.some((c) => c.severity === category)
    ? category
    : ("user_other" as UserReportCategory);

  // createdAt may arrive as a Firestore Timestamp, an ISO string (in
  // optimistic local writes), or undefined while the server stamp is
  // still pending. We coerce defensively rather than dropping the doc.
  let createdMs = 0;
  const ts = d.createdAt;
  if (ts && typeof ts === "object" && "seconds" in ts) {
    createdMs = (ts as { seconds: number }).seconds * 1000;
  } else if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) createdMs = parsed;
  } else if (typeof ts === "number") {
    createdMs = ts;
  }
  if (!createdMs) createdMs = Date.now();

  const expiresMs = typeof d.expiresAt === "number" ? d.expiresAt : createdMs + TTL_MS;

  return {
    id,
    lat,
    lng,
    category: validCategory,
    note: String(d.note ?? "").slice(0, NOTE_MAX),
    ownerUid: String(d.ownerUid ?? ""),
    ownerName: String(d.ownerName ?? "Reporter"),
    createdAtMs: createdMs,
    expiresAtMs: expiresMs,
    confirmCount: typeof d.confirmCount === "number" ? d.confirmCount : 0,
    disputeCount: typeof d.disputeCount === "number" ? d.disputeCount : 0,
  };
}

/** Subscribe to live user reports for the current city. Filters out
 *  anything past its `expiresAt` client-side so dropping a TTL policy
 *  in the Firebase console isn't strictly required. */
export function subscribeUserReports(
  onData: (reports: UserReport[]) => void,
  onError?: (e: Error) => void
): () => void {
  if (!isFirebaseConfigured()) {
    onData([]);
    return () => {};
  }
  const db = getFirestore(getFirebaseApp());
  const q = query(
    collection(db, COLLECTION),
    where("city", "==", getCurrentCity().slug),
    orderBy("createdAt", "desc"),
    limitFn(MAX_DOCS)
  );
  return onSnapshot(
    q,
    (snap) => {
      const now = Date.now();
      const list: UserReport[] = [];
      snap.forEach((d) => {
        const r = mapDoc(d.id, d.data());
        if (!r) return;
        if (r.expiresAtMs <= now) return;
        // Hide reports that have been buried by community disputes.
        // The doc itself stays in Firestore for owner reference and
        // for any moderation surface; a follow-up cleanup function
        // can hard-delete them on a schedule.
        if (r.confirmCount - r.disputeCount <= HIDE_THRESHOLD) return;
        list.push(r);
      });
      onData(list);
    },
    (err) => onError?.(err instanceof Error ? err : new Error(String(err)))
  );
}

/** Vote payload values: +1 confirm, -1 dispute, 0 retract. */
export type UserReportVoteValue = 1 | -1 | 0;

interface VoterSnapshot {
  uid: string;
  isAnonymous: boolean;
}

/** Cast / change / retract a vote on a user report. Uses a Firestore
 *  transaction so the parent's `confirmCount` / `disputeCount`
 *  aggregates stay consistent with the per-voter `votes/{uid}` doc.
 *
 *  Returns the resulting net score (`confirmCount - disputeCount`)
 *  after the vote — handy for the UI to surface "now at +2" feedback
 *  without waiting for the snapshot listener to round-trip. */
export async function voteOnUserReport(
  reportId: string,
  next: UserReportVoteValue,
  voter: VoterSnapshot
): Promise<number> {
  if (!isFirebaseConfigured()) throw new Error("Sign in to vote.");
  if (voter.isAnonymous) throw new Error("Sign in with Google or email to vote.");

  const db = getFirestore(getFirebaseApp());
  const reportRef = doc(db, COLLECTION, reportId);
  const voteRef = doc(db, COLLECTION, reportId, "votes", voter.uid);

  return runTransaction(db, async (tx) => {
    const reportSnap = await tx.get(reportRef);
    if (!reportSnap.exists()) throw new Error("Report no longer exists.");
    const reportData = reportSnap.data();
    // Owners voting on their own report would skew the signal — bail
    // before mutating anything. The UI hides the buttons in this
    // case, but the rule belongs here too as a defense-in-depth.
    if (reportData.ownerUid === voter.uid) {
      throw new Error("You can't vote on your own report.");
    }

    const voteSnap = await tx.get(voteRef);
    const prev: UserReportVoteValue = voteSnap.exists()
      ? ((voteSnap.data().value as 1 | -1) ?? 0)
      : 0;

    if (prev === next) {
      // Nothing changed — return the current aggregates so the caller
      // can still update local UI without a write round-trip.
      return (
        (typeof reportData.confirmCount === "number" ? reportData.confirmCount : 0) -
        (typeof reportData.disputeCount === "number" ? reportData.disputeCount : 0)
      );
    }

    const confirmDelta =
      (next === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
    const disputeDelta =
      (next === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);

    if (next === 0) {
      tx.delete(voteRef);
    } else {
      tx.set(voteRef, {
        value: next,
        voterUid: voter.uid,
        createdAt: serverTimestamp(),
      });
    }
    if (confirmDelta !== 0 || disputeDelta !== 0) {
      tx.update(reportRef, {
        confirmCount: increment(confirmDelta),
        disputeCount: increment(disputeDelta),
      });
    }

    const newConfirm =
      (typeof reportData.confirmCount === "number" ? reportData.confirmCount : 0) + confirmDelta;
    const newDispute =
      (typeof reportData.disputeCount === "number" ? reportData.disputeCount : 0) + disputeDelta;
    return newConfirm - newDispute;
  });
}

/** Read the current viewer's vote on a report (or 0 if none). One-
 *  shot, not subscribed — the UI calls this once per opened popup.
 *  Returns 0 silently if Firebase isn't configured or the user is
 *  anonymous. */
export async function getMyVote(
  reportId: string,
  voterUid: string
): Promise<UserReportVoteValue> {
  if (!isFirebaseConfigured() || !voterUid) return 0;
  const db = getFirestore(getFirebaseApp());
  const ref = doc(db, COLLECTION, reportId, "votes", voterUid);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return 0;
    const v = (snap.data() as { value?: number }).value;
    return v === 1 ? 1 : v === -1 ? -1 : 0;
  } catch {
    return 0;
  }
}

/** Owner-only "thanks, I saw it" acknowledgement — clears the
 *  report from the live layer immediately rather than waiting for
 *  the 4h TTL. Just a thin wrapper around deleteUserReport for
 *  symmetry with the voting controls. */
export async function dismissOwnReport(reportId: string): Promise<void> {
  await deleteUserReport(reportId);
}

/** Admin-only feed: includes hidden / disputed / expired rows so the
 *  moderation surface can show *everything* in the current city,
 *  not just what end-users see on the map. Differs from
 *  `subscribeUserReports` in three ways:
 *    - no client-side `expiresAt` filter (admins should see what
 *      auto-cleanup did or didn't catch)
 *    - no HIDE_THRESHOLD pruning (the whole point of moderation is
 *      to look at things the community already pushed down)
 *    - higher row cap so a busy day doesn't get truncated
 *
 *  Firestore rules still apply — non-admin users that subscribe to
 *  this will simply get an error from `onError`. */
export function subscribeAllUserReportsForAdmin(
  onData: (reports: UserReport[]) => void,
  onError?: (e: Error) => void,
  max = 500
): () => void {
  if (!isFirebaseConfigured()) {
    onData([]);
    return () => {};
  }
  const db = getFirestore(getFirebaseApp());
  const q = query(
    collection(db, COLLECTION),
    where("city", "==", getCurrentCity().slug),
    orderBy("createdAt", "desc"),
    limitFn(max)
  );
  return onSnapshot(
    q,
    (snap) => {
      const list: UserReport[] = [];
      snap.forEach((d) => {
        const r = mapDoc(d.id, d.data());
        if (r) list.push(r);
      });
      onData(list);
    },
    (err) => onError?.(err instanceof Error ? err : new Error(String(err)))
  );
}

/** Hard-delete a report regardless of ownership. Admin-gated by
 *  Firestore rules — calling this as a non-admin will reject. */
export async function adminDeleteUserReport(reportId: string): Promise<void> {
  if (!isFirebaseConfigured()) throw new Error("Offline.");
  const db = getFirestore(getFirebaseApp());
  await deleteDoc(doc(db, COLLECTION, reportId));
}

// Silence an unused-import warning when setDoc isn't referenced
// elsewhere (re-exported for any future test that needs to seed
// votes directly).
export const _setDocForTests = setDoc;

/** Convert a UserReport into an Incident-shaped object so existing
 *  consumers (map markers, alerts inbox, area scoring) can render
 *  them without a code change. The `id` is prefixed with `user-` so
 *  callers can detect crowdsourced rows when they want to special-
 *  case them (e.g. to attach a deletion control or to badge with the
 *  reporter's name).
 *
 *  Confidence is dampened by the net vote score: a report with no
 *  community confirmation defaults to 0.6, climbs toward 0.95 with
 *  confirmations, and drops toward 0.2 with disputes. This piggy-
 *  backs on the existing heatmap weighting (computeWEff multiplies
 *  by confidence) so highly-disputed reports fade out of the
 *  hotspots and confirmed reports sharpen them. */
export function userReportToIncident(r: UserReport): Incident {
  const noteText = r.note ? r.note : USER_REPORT_CATEGORIES.find((c) => c.severity === r.category)?.label ?? "Report";
  const net = r.confirmCount - r.disputeCount;
  // Map net votes into a 0.2…0.95 confidence band via a soft logistic
  // step so a single confirm/dispute moves the needle a bit but the
  // signal saturates instead of going to 0/1 immediately.
  const confidence = Math.max(0.2, Math.min(0.95, 0.6 + 0.12 * net));
  return {
    id: `user-${r.id}`,
    reported_at: new Date(r.createdAtMs).toISOString(),
    raw_text: `[Reported by ${r.ownerName}] ${noteText}`,
    severity_category: r.category,
    s_base: 0.5,
    location_text: null,
    lat: r.lat,
    lng: r.lng,
    confidence,
    geocode_status: "user",
    location_confidence: "direct",
    inhibitor_status: "passed",
    inhibitor_reason: null,
    w_eff: 0.4,
    audio_clip: null,
    audio_url: null,
    feed_id: null,
    description: r.note || null,
  };
}

/** True if the given incident id was minted from a user report. */
export function isUserReportIncidentId(id: string): boolean {
  return id.startsWith("user-");
}

/** Strip the `user-` prefix to recover the underlying Firestore doc id. */
export function userReportIdFromIncidentId(id: string): string {
  return id.startsWith("user-") ? id.slice(5) : id;
}
