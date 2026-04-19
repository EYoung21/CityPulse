"use client";

/** Lifecycle / "is this still happening?" voting for scanner-derived
 *  incidents.
 *
 *  The `incidents` collection is owned by the backend ingest pipeline
 *  and shouldn't be mutated by the client, so lifecycle votes live
 *  in a sibling collection `incidentStatus/{incidentId}`. The doc id
 *  matches the incident id exactly so a single `getDoc` resolves the
 *  status without any extra lookup work in the UI.
 *
 *  Schema:
 *    /incidentStatus/{incidentId}
 *       stillCount:    number   — community "still happening" votes
 *       resolvedCount: number   — community "resolved/cleared" votes
 *       lastVoteAtMs:  number   — newest vote's epoch ms (for "X min ago")
 *       lastVoterUid:  string   — owner of the most recent vote
 *    /incidentStatus/{incidentId}/votes/{voterUid}
 *       value:     "still" | "resolved"
 *       createdAt: serverTimestamp
 *
 *  Why two parallel counts (instead of a signed integer like user
 *  reports use): "resolved" and "still" measure different things —
 *  a busy 6-vote scene with 4 "still" + 2 "resolved" should read as
 *  "still happening (with mixed reports)", not as a quiet +2. The
 *  derived `IncidentLifecycleStatus` collapses the pair into a
 *  single user-facing label using the rules in
 *  `deriveLifecycleStatus`.
 *
 *  Anti-spam: same shape as user-report voting — non-anonymous only,
 *  one vote per user per incident, voter doc id = uid so duplicates
 *  are impossible. Switching your vote moves the counts in lockstep
 *  via a transaction. */

import {
  collection,
  doc,
  getDoc,
  getFirestore,
  increment,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";

const COLLECTION = "incidentStatus";

export type IncidentVoteValue = "still" | "resolved" | null;

export interface IncidentLifecycleAggregate {
  incidentId: string;
  stillCount: number;
  resolvedCount: number;
  /** Epoch ms of the most recent vote, or 0 if no votes yet. Drives
   *  the "X min ago" label so users can spot stale votes (e.g. 14
   *  hours of "still happening" with no fresh confirmations). */
  lastVoteAtMs: number;
}

const EMPTY_AGG = (incidentId: string): IncidentLifecycleAggregate => ({
  incidentId,
  stillCount: 0,
  resolvedCount: 0,
  lastVoteAtMs: 0,
});

/** User-facing label derived from the raw counts. Kept as a pure
 *  function so the UI / marker layer / alerts inbox can all agree
 *  on the same status without round-tripping through React state.
 *
 *  Rules (chosen for low-noise default behaviour):
 *    - "resolved" needs **at least 3** community resolves AND the
 *      resolves must outnumber stills by 2:1 — keeps a single
 *      misclick from flipping a real incident off the map.
 *    - "still" only fires when there are at least 2 still votes;
 *      otherwise we treat the incident as "unverified" so we're not
 *      shouting "STILL HAPPENING" because one passer-by tapped a
 *      button.
 *    - Otherwise: "unverified" — the same default that scanner
 *      incidents already carry. */
export type IncidentLifecycleStatus = "unverified" | "still" | "resolved";

const RESOLVED_MIN = 3;
const RESOLVED_RATIO = 2;
const STILL_MIN = 2;

export function deriveLifecycleStatus(agg: {
  stillCount: number;
  resolvedCount: number;
}): IncidentLifecycleStatus {
  if (
    agg.resolvedCount >= RESOLVED_MIN &&
    agg.resolvedCount >= Math.max(1, agg.stillCount) * RESOLVED_RATIO
  ) return "resolved";
  if (agg.stillCount >= STILL_MIN && agg.stillCount > agg.resolvedCount) return "still";
  return "unverified";
}

interface VoterSnapshot {
  uid: string;
  isAnonymous: boolean;
}

/** Cast / change / retract a vote on a scanner incident. Same
 *  transactional shape as `voteOnUserReport` so the parent doc's
 *  aggregates stay in sync with the per-voter vote.
 *
 *  Pass `next === null` to retract an existing vote without writing
 *  a new one. Returns the resulting aggregate so callers can update
 *  their local UI without waiting for the snapshot listener. */
export async function voteOnIncidentStatus(
  incidentId: string,
  next: IncidentVoteValue,
  voter: VoterSnapshot
): Promise<IncidentLifecycleAggregate> {
  if (!isFirebaseConfigured()) throw new Error("Sign in to vote.");
  if (voter.isAnonymous) throw new Error("Sign in with Google or email to vote.");

  const db = getFirestore(getFirebaseApp());
  const parentRef = doc(db, COLLECTION, incidentId);
  const voteRef = doc(db, COLLECTION, incidentId, "votes", voter.uid);

  return runTransaction(db, async (tx) => {
    const parentSnap = await tx.get(parentRef);
    const voteSnap = await tx.get(voteRef);

    const prev: "still" | "resolved" | null = voteSnap.exists()
      ? (voteSnap.data().value as "still" | "resolved")
      : null;

    const stillBase = parentSnap.exists()
      ? Number((parentSnap.data() as { stillCount?: number }).stillCount ?? 0)
      : 0;
    const resolvedBase = parentSnap.exists()
      ? Number((parentSnap.data() as { resolvedCount?: number }).resolvedCount ?? 0)
      : 0;

    const stillDelta =
      (next === "still" ? 1 : 0) - (prev === "still" ? 1 : 0);
    const resolvedDelta =
      (next === "resolved" ? 1 : 0) - (prev === "resolved" ? 1 : 0);

    if (stillDelta === 0 && resolvedDelta === 0 && next === prev) {
      // No-op — early return without mutating anything so we don't
      // bump the aggregate's lastVoteAt for a redundant click.
      return {
        incidentId,
        stillCount: stillBase,
        resolvedCount: resolvedBase,
        lastVoteAtMs: parentSnap.exists()
          ? Number((parentSnap.data() as { lastVoteAtMs?: number }).lastVoteAtMs ?? 0)
          : 0,
      };
    }

    if (next === null) {
      tx.delete(voteRef);
    } else {
      tx.set(voteRef, {
        value: next,
        voterUid: voter.uid,
        createdAt: serverTimestamp(),
      });
    }

    // Clamp the parent's counts to >= 0 implicitly by always using
    // the local base-plus-delta — we'd rather show a stale 0 for a
    // microsecond than let a corrupted increment go negative.
    const nextStill = Math.max(0, stillBase + stillDelta);
    const nextResolved = Math.max(0, resolvedBase + resolvedDelta);
    const nowMs = Date.now();

    if (parentSnap.exists()) {
      tx.update(parentRef, {
        stillCount: increment(stillDelta),
        resolvedCount: increment(resolvedDelta),
        lastVoteAtMs: nowMs,
        lastVoterUid: voter.uid,
      });
    } else {
      // First vote — create the doc with the count seeded to
      // {0,0} + delta so we don't rely on increment() on a missing
      // document (which Firestore allows but is awkward to reason
      // about under transactions).
      tx.set(parentRef, {
        incidentId,
        stillCount: nextStill,
        resolvedCount: nextResolved,
        lastVoteAtMs: nowMs,
        lastVoterUid: voter.uid,
      });
    }

    return {
      incidentId,
      stillCount: nextStill,
      resolvedCount: nextResolved,
      lastVoteAtMs: nowMs,
    };
  });
}

/** Subscribe to a single incident's lifecycle aggregate. Returns an
 *  unsubscribe. Calls `onData` with an empty aggregate the moment
 *  the listener attaches so the UI can render even before the first
 *  Firestore round-trip. */
export function subscribeIncidentStatus(
  incidentId: string,
  onData: (agg: IncidentLifecycleAggregate) => void,
  onError?: (e: Error) => void
): () => void {
  if (!isFirebaseConfigured() || !incidentId) {
    onData(EMPTY_AGG(incidentId));
    return () => {};
  }
  const db = getFirestore(getFirebaseApp());
  const ref = doc(db, COLLECTION, incidentId);
  // Fire an immediate empty aggregate so the IncidentDetail's status
  // chip doesn't pop in late.
  onData(EMPTY_AGG(incidentId));
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        onData(EMPTY_AGG(incidentId));
        return;
      }
      const d = snap.data() as Record<string, unknown>;
      onData({
        incidentId,
        stillCount: Number(d.stillCount ?? 0),
        resolvedCount: Number(d.resolvedCount ?? 0),
        lastVoteAtMs: Number(d.lastVoteAtMs ?? 0),
      });
    },
    (err) => onError?.(err instanceof Error ? err : new Error(String(err)))
  );
}

/** One-shot read of the viewer's own vote on `incidentId`. Returns
 *  `null` if they haven't voted (or if Firebase isn't configured /
 *  the user is anonymous). */
export async function getMyIncidentVote(
  incidentId: string,
  voterUid: string | null | undefined
): Promise<IncidentVoteValue> {
  if (!isFirebaseConfigured() || !voterUid || !incidentId) return null;
  const db = getFirestore(getFirebaseApp());
  const ref = doc(db, COLLECTION, incidentId, "votes", voterUid);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const v = (snap.data() as { value?: string }).value;
    return v === "still" || v === "resolved" ? v : null;
  } catch {
    return null;
  }
}

/** Subscribe to *all* recently-voted-on lifecycle aggregates so the
 *  page-level layer can enrich incidents in bulk. Only docs whose
 *  most recent vote is younger than `windowHours` are returned;
 *  beyond that the community signal is too stale to act on (e.g. a
 *  3-day-old "still happening" should fall back to scanner-only
 *  visualization).
 *
 *  Returns an unsubscribe. The callback is fired once per snapshot
 *  with a fresh `Map<incidentId, IncidentLifecycleAggregate>`. We
 *  intentionally don't apply `deriveLifecycleStatus` here — callers
 *  do that at the point of use so the same map can drive both the
 *  marker fade (resolved → low alpha) and the heatmap weight (still
 *  → 1.2x; resolved → 0.15x). */
export function subscribeAllIncidentStatuses(
  onData: (statuses: Map<string, IncidentLifecycleAggregate>) => void,
  opts?: { windowHours?: number; onError?: (e: Error) => void }
): () => void {
  if (!isFirebaseConfigured()) {
    onData(new Map());
    return () => {};
  }
  const windowHours = opts?.windowHours ?? 48;
  const cutoff = Date.now() - windowHours * 3600_000;
  const db = getFirestore(getFirebaseApp());
  // The `lastVoteAtMs` filter keeps the listener cheap as the
  // collection grows: incidents that haven't been voted on in days
  // don't influence the visualization. The query is intentionally
  // small / read-only so the cost stays predictable.
  const q = query(
    collection(db, COLLECTION),
    where("lastVoteAtMs", ">=", cutoff)
  );
  return onSnapshot(
    q,
    (snap) => {
      const next = new Map<string, IncidentLifecycleAggregate>();
      snap.forEach((d) => {
        const data = d.data() as Record<string, unknown>;
        next.set(d.id, {
          incidentId: d.id,
          stillCount: Number(data.stillCount ?? 0),
          resolvedCount: Number(data.resolvedCount ?? 0),
          lastVoteAtMs: Number(data.lastVoteAtMs ?? 0),
        });
      });
      onData(next);
    },
    (err) => opts?.onError?.(err instanceof Error ? err : new Error(String(err)))
  );
}

/** Format a "X min ago" string from epoch ms — used by the
 *  IncidentDetail status chip. Returns "" when the input is 0 so
 *  the caller can avoid rendering a label on a never-voted
 *  incident. */
export function formatLastVoteAgo(ms: number): string {
  if (!ms) return "";
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}
