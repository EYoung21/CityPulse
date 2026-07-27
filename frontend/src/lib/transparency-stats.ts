"use client";

/** Aggregate stats for the public /transparency page. The shape is
 *  intentionally small — we want a snapshot of community moderation
 *  health that loads fast and doesn't require any per-row drill-down.
 *
 *  Why fetch from the client (not pre-render at build): the
 *  underlying collections change continuously, and the page is
 *  rarely-visited (transparency is a trust signal, not a daily
 *  destination). Pre-rendering would mean either stale numbers or a
 *  build cron we don't have. Live client reads with a 30-day
 *  bounded query keep cost predictable and numbers fresh.
 *
 *  Privacy: we only return aggregates and category breakdowns. No
 *  user identifiers or note bodies make it into the stats payload.
 */

import {
  collection,
  getDocs,
  getFirestore,
} from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { fetchIncidentCount, getDocsWithDeadline } from "@/lib/firestore";
import { getCurrentCity } from "@/lib/pulse-cities";

const DAY_MS = 24 * 3600 * 1000;

export interface TransparencyStats {
  city: string;
  /** Inclusive lower bound of the analysis window (epoch ms). All
   *  counts below cover the trailing N-day window ending at "now". */
  windowStartMs: number;
  /** ms span of the window. */
  windowMs: number;
  /** Status updates moderators applied to feedback rows. */
  feedbackTriaged: number | null;
  /** Total published public-source incidents in the window. */
  publicIncidents: number | null;
  /** Stats for the moderation audit log itself — surfaces
   *  transparency about the moderators (not just the moderated). */
  totalAuditEntries: number | null;
  /** Wall-clock timestamp the snapshot was assembled. Use this for
   *  the "last updated" footer instead of `Date.now()` so a stale
   *  cached page doesn't lie about freshness. */
  fetchedAtMs: number;
}

const EMPTY_STATS = (city: string, windowMs: number): TransparencyStats => ({
  city,
  windowStartMs: Date.now() - windowMs,
  windowMs,
  feedbackTriaged: null,
  publicIncidents: null,
  totalAuditEntries: null,
  fetchedAtMs: Date.now(),
});

/** Load the public transparency snapshot. Defaults to a 30-day
 *  window. Rethrows network/permission errors so the calling page
 *  can decide whether to render an error vs. a "no data" state. */
export async function fetchTransparencyStats(
  windowDays = 30
): Promise<TransparencyStats> {
  const city = getCurrentCity().slug;
  const windowMs = windowDays * DAY_MS;
  if (!isFirebaseConfigured()) {
    return EMPTY_STATS(city, windowMs);
  }
  const db = getFirestore(getFirebaseApp());
  const now = Date.now();
  const cutoffMs = now - windowMs;
  const stats = EMPTY_STATS(city, windowMs);

  // The audit query is expected to fail for public visitors, while the
  // incident aggregate is public. Run them concurrently so a slow Firestore
  // permission/network failure cannot hold the public metric hostage.
  const [auditResult, incidentResult] = await Promise.allSettled([
    getDocsWithDeadline(getDocs(collection(db, "moderationAudit")), undefined, 5_000),
    fetchIncidentCount({ hours: windowDays * 24 }),
  ]);

  // ── Audit log ────────────────────────────────────────────────────
  // Audit entries require admin read — for an unauthenticated visitor
  // this query will fail. Leave those metrics unavailable while still
  // rendering the rest of the snapshot.
  if (auditResult.status === "fulfilled") {
    const snap = auditResult.value;
    let totalAuditEntries = 0;
    let feedbackTriaged = 0;
    snap.forEach((d) => {
      const data = d.data() as Record<string, unknown>;
      const createdAtRaw = data.createdAt as
        | { toMillis?: () => number }
        | number
        | undefined;
      const createdMs =
        typeof createdAtRaw === "number"
          ? createdAtRaw
          : typeof createdAtRaw?.toMillis === "function"
            ? createdAtRaw.toMillis()
            : 0;
      if (createdMs && createdMs < cutoffMs) return;
      totalAuditEntries += 1;
      const kind = String(data.kind ?? "");
      if (kind === "feedback.status") feedbackTriaged += 1;
    });
    stats.totalAuditEntries = totalAuditEntries;
    stats.feedbackTriaged = feedbackTriaged;
  }

  // ── Public-source incidents (context) ────────────────────────────
  // Use the server-cached Firestore count aggregation. The old implementation
  // downloaded every incident in the city into each visitor's browser merely
  // to count the last 30 days, causing slow loads and runaway read costs.
  if (incidentResult.status === "fulfilled") {
    const count = incidentResult.value;
    if (count >= 0) stats.publicIncidents = count;
  }

  stats.fetchedAtMs = Date.now();
  return stats;
}

/** Format helpers used by the page so we don't sprinkle the same
 *  Intl plumbing through the JSX. */
export const fmtPct = (numerator: number, denominator: number): string => {
  if (!denominator) return "-";
  const pct = (numerator / denominator) * 100;
  // Show whole percent below 10 to avoid jittery decimal noise; show
  // one decimal for low-share categories so they don't all read 0%.
  return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
};

export const fmtNumber = (n: number): string =>
  new Intl.NumberFormat("en-US").format(n);
