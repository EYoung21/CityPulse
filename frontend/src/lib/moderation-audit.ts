"use client";

/** Moderation audit log — append-only ledger of every admin action
 *  taken from the moderation surface. Lives in a dedicated
 *  `moderationAudit` collection so it's:
 *
 *    1. Easy to query in isolation (Firestore console, BigQuery
 *       export, etc.) without joining against the source rows.
 *    2. Resilient to the source row being deleted — the audit
 *       entry captures the metadata (id, kind, brief snippet) at
 *       the moment of action so a follow-up "why was this gone"
 *       question can be answered even after the doc is purged.
 *    3. Tamper-evident: rules below are append-only — admins can
 *       create entries, but nobody (not even another admin) can
 *       update or delete them client-side. Hard purges have to be
 *       done from the Firebase console with explicit intent.
 *
 *  Every action funnels through `recordModerationAction` so we keep
 *  one chokepoint instead of scattering audit writes across feedback.ts.
 *  The wrappers below (`auditSetFeedbackStatus`, `auditDeleteFeedback`)
 *  are the preferred API for the moderation panel — they perform the
 *  action and then write the audit row in a "best-effort, fail-loud"
 *  pattern: if the action succeeds but audit fails, we surface the
 *  audit failure so the admin knows to retry / investigate.
 */

import {
  addDoc,
  collection,
  getFirestore,
  limit as limitFn,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import {
  adminDeleteFeedback,
  setFeedbackStatus,
  type FeedbackStatus,
} from "@/lib/feedback";

const COLLECTION = "moderationAudit";

export type ModerationActionKind =
  | "feedback.delete"
  | "feedback.status";

export interface ModerationAuditEntry {
  id: string;
  /** Action that was performed. Acts like an event-name so callers
   *  can filter the audit feed by kind without parsing. */
  kind: ModerationActionKind;
  /** Firestore id of the row the action targeted. Kept even after
   *  the source doc is deleted so we can trace back to "this report
   *  used to exist". */
  targetId: string;
  /** Human-readable snapshot of the target at the time of the
   *  action — caps at ~140 chars so the ledger stays cheap. Use for
   *  UI rendering only; don't rely on it for downstream logic. */
  targetSnippet: string | null;
  /** Optional structured payload (e.g. previous + next status for
   *  feedback.status events). Bounded by Firestore doc size limits;
   *  callers should keep payloads small. */
  payload: Record<string, unknown>;
  actorUid: string;
  actorEmail: string | null;
  actorDisplayName: string | null;
  createdAtMs: number;
}

interface ActorSnapshot {
  uid: string;
  email: string | null;
  displayName: string | null;
}

interface RecordInput {
  kind: ModerationActionKind;
  targetId: string;
  targetSnippet?: string | null;
  payload?: Record<string, unknown>;
}

/** Low-level append. Most callers should use the auditX wrappers
 *  below, but this is exported for places that need to log a custom
 *  event without coupling to a specific action helper. */
export async function recordModerationAction(
  input: RecordInput,
  actor: ActorSnapshot
): Promise<string> {
  if (!isFirebaseConfigured()) {
    throw new Error("Audit log unavailable offline.");
  }
  if (!actor.uid) throw new Error("Sign in to perform admin actions.");
  const db = getFirestore(getFirebaseApp());
  const ref = await addDoc(collection(db, COLLECTION), {
    kind: input.kind,
    targetId: input.targetId,
    targetSnippet: (input.targetSnippet ?? "").slice(0, 140) || null,
    payload: input.payload || {},
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorDisplayName: actor.displayName,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

interface SubscribeOpts {
  /** Server-side filter by event kind. Combined with
   *  orderBy(createdAt desc). */
  kind?: ModerationActionKind;
  /** Hard cap on rows returned. Defaults to 200. */
  limit?: number;
}

export function subscribeModerationAudit(
  opts: SubscribeOpts,
  onData: (rows: ModerationAuditEntry[]) => void,
  onError?: (err: Error) => void
): () => void {
  if (!isFirebaseConfigured()) { onData([]); return () => {}; }
  const db = getFirestore(getFirebaseApp());
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc")];
  if (opts.kind) constraints.unshift(where("kind", "==", opts.kind));
  constraints.push(limitFn(opts.limit ?? 200));
  const q = query(collection(db, COLLECTION), ...constraints);
  return onSnapshot(
    q,
    (snap) => {
      const rows: ModerationAuditEntry[] = [];
      snap.forEach((d) => {
        const data = d.data() as Record<string, unknown>;
        const createdAtRaw = data.createdAt as
          | { toMillis?: () => number }
          | number
          | undefined;
        const createdAtMs =
          typeof createdAtRaw === "number"
            ? createdAtRaw
            : typeof createdAtRaw?.toMillis === "function"
              ? createdAtRaw.toMillis()
              : Date.now();
        rows.push({
          id: d.id,
          kind: (data.kind as ModerationActionKind) ?? "feedback.status",
          targetId: String(data.targetId ?? ""),
          targetSnippet:
            typeof data.targetSnippet === "string" ? data.targetSnippet : null,
          payload: (data.payload as Record<string, unknown>) || {},
          actorUid: String(data.actorUid ?? ""),
          actorEmail: typeof data.actorEmail === "string" ? data.actorEmail : null,
          actorDisplayName:
            typeof data.actorDisplayName === "string" ? data.actorDisplayName : null,
          createdAtMs,
        });
      });
      onData(rows);
    },
    (err) => onError?.(err instanceof Error ? err : new Error(String(err)))
  );
}

// ---- Audited action wrappers -----------------------------------------
// Each wrapper performs the destructive action first, then writes the
// audit row. We do it in that order because a successful action with
// missing audit is a louder failure (admin notified) than a failed
// action with no audit (a no-op). If the audit write fails we
// surface the error but the underlying action stays applied — better
// than rolling back a moderation decision over a tail-write failure.

export async function auditDeleteFeedback(
  feedbackId: string,
  snippet: string,
  actor: ActorSnapshot
): Promise<void> {
  await adminDeleteFeedback(feedbackId);
  try {
    await recordModerationAction(
      {
        kind: "feedback.delete",
        targetId: feedbackId,
        targetSnippet: snippet,
      },
      actor
    );
  } catch (e) {
    throw new Error(
      `Feedback deleted, but audit log write failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export async function auditSetFeedbackStatus(
  feedbackId: string,
  prev: FeedbackStatus,
  next: FeedbackStatus,
  snippet: string,
  actor: ActorSnapshot
): Promise<void> {
  if (prev === next) return; // no-op, don't pollute the audit feed
  await setFeedbackStatus(feedbackId, next);
  try {
    await recordModerationAction(
      {
        kind: "feedback.status",
        targetId: feedbackId,
        targetSnippet: snippet,
        payload: { from: prev, to: next },
      },
      actor
    );
  } catch (e) {
    throw new Error(
      `Status updated, but audit log write failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/** Tiny pretty-printer for audit rows in the UI. */
export function describeAuditAction(entry: ModerationAuditEntry): string {
  switch (entry.kind) {
    case "feedback.delete":
      return "Deleted feedback";
    case "feedback.status": {
      const from = entry.payload.from as string | undefined;
      const to = entry.payload.to as string | undefined;
      if (from && to) return `Set feedback ${from} → ${to}`;
      return "Updated feedback status";
    }
    default:
      return "Moderation action";
  }
}
