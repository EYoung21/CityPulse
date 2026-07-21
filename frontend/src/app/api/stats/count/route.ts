import { NextRequest, NextResponse } from "next/server";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { COUNT_API_ALLOWED_HOURS } from "@/lib/time-filters";
import { classifyCountFailure } from "@/lib/count-failure";

const TRANSIENT_WARNING_INTERVAL_MS = 60_000;
let lastTransientWarningAt = 0;

/**
 * Public read-only count endpoint.
 *
 * GET /api/stats/count?city=<slug>&hours=<int>
 *   - 1 Firestore aggregate read per server hit, regardless of N docs.
 *   - Aggressively CDN-cached so visitors share a single read across
 *     a 5-min window — most page loads pay zero Firestore reads.
 *
 * Returns { city, sinceISO, hours, count } on success.
 */

const COLLECTION = "incidents";
const ALLOWED_HOURS = COUNT_API_ALLOWED_HOURS;
// Slug-safe city: lowercase letters + dashes only; nothing weird leaks
// into the Firestore query.
const CITY_RE = /^[a-z][a-z0-9-]{0,40}$/;

function getAdminDb() {
  if (getApps().length === 0) {
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (process.env.FIREBASE_ADMIN_KEY) {
      initializeApp({
        credential: cert(JSON.parse(process.env.FIREBASE_ADMIN_KEY)),
      });
    } else {
      initializeApp({ projectId });
    }
  }
  return getFirestore();
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const city = (searchParams.get("city") ?? "").trim().toLowerCase();
  const hoursParam = (searchParams.get("hours") ?? "").trim().toLowerCase();
  const isAll = hoursParam === "all";
  const hoursRaw = isAll ? null : Number(hoursParam);

  if (!CITY_RE.test(city)) {
    return NextResponse.json({ error: "invalid city" }, { status: 400 });
  }
  if (!isAll && (hoursRaw == null || !Number.isFinite(hoursRaw) || !ALLOWED_HOURS.has(hoursRaw))) {
    return NextResponse.json({ error: "invalid hours" }, { status: 400 });
  }

  const sinceISO =
    hoursRaw != null
      ? new Date(Date.now() - hoursRaw * 3600_000).toISOString()
      : null;

  try {
    const db = getAdminDb();
    const base = db.collection(COLLECTION).where("city", "==", city);
    const q = sinceISO ? base.where("reported_at", ">=", sinceISO) : base;
    const snap = await q.count().get();
    const count = snap.data().count;

    return NextResponse.json(
      { city, hours: isAll ? "all" : hoursRaw, sinceISO, count },
      {
        headers: {
          // CDN caches for 5 min; serves stale for an extra 10 min
          // while revalidating in the background. Picks the same lane
          // Vercel/Next data routes use, so this works on default
          // hosting without bespoke edge config.
          "Cache-Control":
            "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    // Log to server-side stdout (visible in Vercel/host logs) so the
    // root cause — missing FIREBASE_ADMIN_KEY, missing composite index,
    // permissioning, etc. — isn't hidden behind the 500. The detail is
    // also returned in the body so curl-from-the-frontend debugging
    // surfaces it without needing host log access.
    const failure = classifyCountFailure(msg);
    const context = { city, hoursParam, error: msg };
    if (failure.status === 503) {
      const now = Date.now();
      if (now - lastTransientWarningAt >= TRANSIENT_WARNING_INTERVAL_MS) {
        lastTransientWarningAt = now;
        console.warn("[/api/stats/count] temporarily unavailable:", context);
      }
    } else {
      console.error("[/api/stats/count] failed:", context);
    }
    const headers: Record<string, string> = {};
    if (failure.status === 503) {
      headers["Retry-After"] = "45";
    }
    return NextResponse.json(
      {
        error: failure.publicMessage,
        ...(process.env.NODE_ENV !== "production" ? { detail: msg } : {}),
      },
      { status: failure.status, headers },
    );
  }
}
