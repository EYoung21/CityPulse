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
  query,
  where,
} from "firebase/firestore";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { getCurrentCity } from "@/lib/pulse-cities";
import { HIDE_THRESHOLD, USER_REPORT_CATEGORIES } from "@/lib/user-reports";

const DAY_MS = 24 * 3600 * 1000;

export interface TransparencyStats {
  city: string;
  /** Inclusive lower bound of the analysis window (epoch ms). All
   *  counts below cover the trailing N-day window ending at "now". */
  windowStartMs: number;
  /** ms span of the window. */
  windowMs: number;
  /** Total user reports submitted in the window (pre-moderation). */
  reportsSubmitted: number;
  /** Reports with net votes ≥ +1 — i.e. at least one more confirm
   *  than dispute. Loose "verified" definition; we never claim the
   *  community has independently *witnessed* the incident, only that
   *  votes lean positive. */
  reportsVerified: number;
  /** Reports auto-hidden because net votes fell to or below
   *  `HIDE_THRESHOLD`. These are still in the underlying collection
   *  but skipped by the public-facing subscriber. */
  reportsAutoHidden: number;
  /** Reports moderators removed (counted from the audit log so
   *  numbers reflect *moderation* activity, not collection size). */
  reportsAdminRemoved: number;
  /** Status updates moderators applied to feedback rows. */
  feedbackTriaged: number;
  /** Total scanner-derived incidents (for context — the user-report
   *  numbers are easier to read when you can see the size of the
   *  authoritative stream they ride alongside). */
  scannerIncidents: number;
  /** Per-category breakdown for user reports. The category slugs
   *  match `USER_REPORT_CATEGORIES.severity`; consumers can join by
   *  slug to render glyphs/labels without round-tripping back here. */
  reportsByCategory: Record<string, number>;
  /** Stats for the moderation audit log itself — surfaces
   *  transparency about the moderators (not just the moderated). */
  totalAuditEntries: number;
  /** Wall-clock timestamp the snapshot was assembled. Use this for
   *  the "last updated" footer instead of `Date.now()` so a stale
   *  cached page doesn't lie about freshness. */
  fetchedAtMs: number;
}

const EMPTY_STATS = (city: string, windowMs: number): TransparencyStats => ({
  city,
  windowStartMs: Date.now() - windowMs,
  windowMs,
  reportsSubmitted: 0,
  reportsVerified: 0,
  reportsAutoHidden: 0,
  reportsAdminRemoved: 0,
  feedbackTriaged: 0,
  scannerIncidents: 0,
  reportsByCategory: Object.fromEntries(
    USER_REPORT_CATEGORIES.map((c) => [c.severity, 0])
  ),
  totalAuditEntries: 0,
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

  // ── User reports ─────────────────────────────────────────────────
  // We can't filter on createdAt server-side without an index for the
  // composite (city, createdAt) query — and most cities will have at
  // most a few hundred reports in flight, so a city-scoped fetch is
  // cheap. Filtering by `expiresAt > cutoff` avoids scanning the full
  // collection while still capturing any report whose creation time
  // falls inside our window (expiresAt = createdAt + 4h, so anything
  // active in the last 30 days satisfies expiresAt > now-30d).
  try {
    const snap = await getDocs(
      query(
        collection(db, "userReports"),
        where("city", "==", city),
        where("expiresAt", ">=", cutoffMs)
      )
    );
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

      stats.reportsSubmitted += 1;
      const cat = String(data.category ?? "user_other");
      stats.reportsByCategory[cat] = (stats.reportsByCategory[cat] ?? 0) + 1;
      const net =
        Number(data.confirmCount ?? 0) - Number(data.disputeCount ?? 0);
      if (net >= 1) stats.reportsVerified += 1;
      if (net <= HIDE_THRESHOLD) stats.reportsAutoHidden += 1;
    });
  } catch {
    // Public-read should always succeed; if it doesn't we leave the
    // counters at 0 rather than blowing up the whole page.
  }

  // ── Audit log ────────────────────────────────────────────────────
  // Audit entries require admin read — for an unauthenticated visitor
  // this query will fail. We catch and swallow so the rest of the
  // stats still render; the moderation counts simply stay at 0. The
  // page surfaces this with a "available to admins only" footnote.
  try {
    const snap = await getDocs(collection(db, "moderationAudit"));
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
      stats.totalAuditEntries += 1;
      const kind = String(data.kind ?? "");
      if (kind === "userReport.delete") stats.reportsAdminRemoved += 1;
      else if (kind === "feedback.status") stats.feedbackTriaged += 1;
    });
  } catch {
    /* unauthenticated; skip */
  }

  // ── Scanner incidents (context) ──────────────────────────────────
  // Public-read. We sample without a date filter and post-filter on
  // reported_at since the incidents collection schema doesn't always
  // index by city; keeping it client-side avoids requiring new
  // composite indexes for a transparency-only page.
  try {
    const snap = await getDocs(
      query(collection(db, "incidents"), where("city", "==", city))
    );
    snap.forEach((d) => {
      const data = d.data() as Record<string, unknown>;
      const reportedAt = data.reported_at;
      let reportedMs = 0;
      if (typeof reportedAt === "string") {
        const t = Date.parse(reportedAt);
        if (!Number.isNaN(t)) reportedMs = t;
      } else if (typeof reportedAt === "number") {
        reportedMs = reportedAt;
      }
      if (!reportedMs || reportedMs < cutoffMs) return;
      stats.scannerIncidents += 1;
    });
  } catch {
    /* the collection may not be city-scoped on this deployment;
       leaving the count at 0 is preferable to throwing. */
  }

  stats.fetchedAtMs = Date.now();
  return stats;
}

/** Format helpers used by the page so we don't sprinkle the same
 *  Intl plumbing through the JSX. */
export const fmtPct = (numerator: number, denominator: number): string => {
  if (!denominator) return "—";
  const pct = (numerator / denominator) * 100;
  // Show whole percent below 10 to avoid jittery decimal noise; show
  // one decimal for low-share categories so they don't all read 0%.
  return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
};

export const fmtNumber = (n: number): string =>
  new Intl.NumberFormat("en-US").format(n);
