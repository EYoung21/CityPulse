"use client";

/** Tiny in-app feedback / bug-report submitter.
 *
 *  Writes to Firestore `feedback/{id}`. Public-create, admin-read
 *  (rules pinned to the same admin email allow-list used elsewhere).
 *  We attach lightweight context (app version, viewport, pulse city,
 *  user-agent slug) so triage doesn't have to play 20 questions —
 *  but never anything sensitive (no precise location, no map state,
 *  no auth token).
 *
 *  Anonymous submissions are allowed (auth not required) so users can
 *  report breakage even if sign-in itself is what's broken. We mirror
 *  the auth uid + email when available so the team can follow up.
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
  updateDoc,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { getCurrentCity } from "@/lib/pulse-cities";

const COLLECTION = "feedback";
const MESSAGE_MAX = 1000;
const EMAIL_MAX = 254;
const RATE_LIMIT_MS = 30_000;
const RATE_LIMIT_KEY = "pp:feedback-last-submit";

export type FeedbackKind = "bug" | "feature" | "praise" | "other";

export const FEEDBACK_KINDS: { kind: FeedbackKind; label: string; hint: string }[] = [
  { kind: "bug",     label: "Something's broken",  hint: "Crashes, wrong data, layout bugs"     },
  { kind: "feature", label: "Feature request",     hint: "What would make PhillyPulse better?" },
  { kind: "praise",  label: "Good vibes",          hint: "Tell us what you love (we read it!)"  },
  { kind: "other",   label: "General feedback",    hint: "Anything else"                         },
];

interface SubmitInput {
  kind: FeedbackKind;
  message: string;
  /** Optional contact email — only used if the user is signed-out
   *  or wants us to reply at a different address than their account. */
  contactEmail?: string;
}

interface CurrentUserSnapshot {
  uid: string | null;
  email: string | null;
  displayName: string | null;
  isAnonymous: boolean;
}

/** Lightweight client-context that we always attach so reports are
 *  actionable without a back-and-forth. Nothing personally
 *  identifying beyond what the user already exposes by visiting the
 *  site. */
function collectContext() {
  if (typeof window === "undefined") return {};
  return {
    url: window.location.pathname + window.location.hash,
    userAgent: navigator.userAgent.slice(0, 240),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio || 1,
    language: navigator.language || null,
    online: navigator.onLine,
    city: getCurrentCity().slug,
  };
}

export function checkRateLimit(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RATE_LIMIT_KEY);
    if (!raw) return null;
    const last = Number(raw);
    const now = Date.now();
    if (!Number.isFinite(last) || last <= 0 || last > now + 60_000) return null;
    const elapsed = now - last;
    if (elapsed >= RATE_LIMIT_MS) return null;
    const wait = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
    return `Wait ${wait}s before sending more feedback.`;
  } catch {
    return null;
  }
}

export async function submitFeedback(
  input: SubmitInput,
  user: CurrentUserSnapshot
): Promise<string> {
  if (!isFirebaseConfigured()) {
    throw new Error("Feedback isn't available offline. Try again when you're connected.");
  }
  const message = input.message.trim();
  if (!message) throw new Error("Add a quick description before sending.");
  if (message.length > MESSAGE_MAX) {
    throw new Error(`Keep it under ${MESSAGE_MAX} characters please.`);
  }
  const blocked = checkRateLimit();
  if (blocked) throw new Error(blocked);

  const contactEmail = (input.contactEmail ?? "").trim().slice(0, EMAIL_MAX) || null;
  // Loose email sanity check — we don't want to reject obviously
  // valid addresses with strict regex, just catch obvious typos.
  if (contactEmail && !/^\S+@\S+\.\S+$/.test(contactEmail)) {
    throw new Error("That email doesn't look right. Double-check the format.");
  }

  const db = getFirestore(getFirebaseApp());
  const ref = await addDoc(collection(db, COLLECTION), {
    kind: input.kind,
    message: message.slice(0, MESSAGE_MAX),
    contactEmail,
    ownerUid: user.uid,
    ownerEmail: user.email,
    ownerDisplayName: user.displayName,
    ownerIsAnonymous: user.isAnonymous,
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION || "dev",
    context: collectContext(),
    createdAt: serverTimestamp(),
    status: "new",
  });

  try {
    window.localStorage.setItem(RATE_LIMIT_KEY, String(Date.now()));
  } catch { /* ignore */ }

  return ref.id;
}

// ---- Admin-side helpers --------------------------------------------------
// These all assume the caller is an admin; Firestore rules enforce
// the actual read/write checks. We don't pre-validate here so a
// stale UI flag never blocks the rule from being the source of
// truth.

/** Triage status set on the parent doc by admins. `new` is the
 *  default value written at submission time. */
export type FeedbackStatus = "new" | "triaged" | "resolved" | "wontfix";

export const FEEDBACK_STATUSES: { value: FeedbackStatus; label: string; color: string }[] = [
  { value: "new",      label: "New",      color: "#3b82f6" },
  { value: "triaged",  label: "Triaged",  color: "#a855f7" },
  { value: "resolved", label: "Resolved", color: "#22c55e" },
  { value: "wontfix",  label: "Won't fix", color: "#64748b" },
];

export interface FeedbackEntry {
  id: string;
  kind: FeedbackKind;
  message: string;
  contactEmail: string | null;
  ownerUid: string | null;
  ownerEmail: string | null;
  ownerDisplayName: string | null;
  ownerIsAnonymous: boolean;
  appVersion: string;
  context: Record<string, unknown>;
  createdAtMs: number;
  status: FeedbackStatus;
}

function mapFeedback(id: string, d: Record<string, unknown>): FeedbackEntry | null {
  if (typeof d.message !== "string" || typeof d.kind !== "string") return null;
  const allowedKinds = new Set<FeedbackKind>(["bug", "feature", "praise", "other"]);
  if (!allowedKinds.has(d.kind as FeedbackKind)) return null;
  // Firestore Timestamps expose toMillis(); legacy or pending writes
  // may carry a number directly. Fall back to Date.now() so the row
  // still renders and can be triaged.
  const createdAtRaw = d.createdAt as { toMillis?: () => number } | number | undefined;
  const createdAtMs =
    typeof createdAtRaw === "number"
      ? createdAtRaw
      : typeof createdAtRaw?.toMillis === "function"
        ? createdAtRaw.toMillis()
        : Date.now();
  const status = (d.status as FeedbackStatus) || "new";
  return {
    id,
    kind: d.kind as FeedbackKind,
    message: String(d.message ?? "").slice(0, MESSAGE_MAX),
    contactEmail: typeof d.contactEmail === "string" ? d.contactEmail : null,
    ownerUid: typeof d.ownerUid === "string" ? d.ownerUid : null,
    ownerEmail: typeof d.ownerEmail === "string" ? d.ownerEmail : null,
    ownerDisplayName: typeof d.ownerDisplayName === "string" ? d.ownerDisplayName : null,
    ownerIsAnonymous: !!d.ownerIsAnonymous,
    appVersion: typeof d.appVersion === "string" ? d.appVersion : "?",
    context: (d.context as Record<string, unknown>) || {},
    createdAtMs,
    status,
  };
}

interface SubscribeFeedbackOpts {
  /** When set, server-side filters to just rows in that status.
   *  Combined with `orderBy(createdAt, desc)` so admins always see
   *  the freshest items first within a column. */
  status?: FeedbackStatus;
  /** Hard cap on rows returned. Defaults to 200 — enough for a busy
   *  triage day without pulling unbounded reads if the backlog
   *  explodes. */
  limit?: number;
}

/** Live admin feed of feedback rows. Returns an unsubscribe. */
export function subscribeFeedback(
  opts: SubscribeFeedbackOpts,
  onData: (rows: FeedbackEntry[]) => void,
  onError?: (err: Error) => void
): () => void {
  if (!isFirebaseConfigured()) { onData([]); return () => {}; }
  const db = getFirestore(getFirebaseApp());
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc")];
  if (opts.status) constraints.unshift(where("status", "==", opts.status));
  constraints.push(limitFn(opts.limit ?? 200));
  const q = query(collection(db, COLLECTION), ...constraints);
  return onSnapshot(
    q,
    (snap) => {
      const rows: FeedbackEntry[] = [];
      snap.forEach((d) => {
        const row = mapFeedback(d.id, d.data());
        if (row) rows.push(row);
      });
      onData(rows);
    },
    (err) => onError?.(err instanceof Error ? err : new Error(String(err)))
  );
}

/** Mark a row's triage status. Rules restrict the diff to just the
 *  status field plus a triagedAt timestamp. */
export async function setFeedbackStatus(
  id: string,
  next: FeedbackStatus
): Promise<void> {
  if (!isFirebaseConfigured()) throw new Error("Offline.");
  const db = getFirestore(getFirebaseApp());
  await updateDoc(doc(db, COLLECTION, id), {
    status: next,
    triagedAt: serverTimestamp(),
  });
}

/** Hard-delete a feedback row. Admin-only (Firestore rule). */
export async function adminDeleteFeedback(id: string): Promise<void> {
  if (!isFirebaseConfigured()) throw new Error("Offline.");
  const db = getFirestore(getFirebaseApp());
  await deleteDoc(doc(db, COLLECTION, id));
}
