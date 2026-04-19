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
  getFirestore,
  limit as limitFn,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
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
}

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
        list.push(r);
      });
      onData(list);
    },
    (err) => onError?.(err instanceof Error ? err : new Error(String(err)))
  );
}

/** Convert a UserReport into an Incident-shaped object so existing
 *  consumers (map markers, alerts inbox, area scoring) can render
 *  them without a code change. The `id` is prefixed with `user-` so
 *  callers can detect crowdsourced rows when they want to special-
 *  case them (e.g. to attach a deletion control or to badge with the
 *  reporter's name). */
export function userReportToIncident(r: UserReport): Incident {
  const noteText = r.note ? r.note : USER_REPORT_CATEGORIES.find((c) => c.severity === r.category)?.label ?? "Report";
  return {
    id: `user-${r.id}`,
    reported_at: new Date(r.createdAtMs).toISOString(),
    raw_text: `[Reported by ${r.ownerName}] ${noteText}`,
    severity_category: r.category,
    s_base: 0.5,
    location_text: null,
    lat: r.lat,
    lng: r.lng,
    confidence: 0.6,
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
