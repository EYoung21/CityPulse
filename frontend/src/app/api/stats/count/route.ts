import { NextRequest, NextResponse } from "next/server";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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
const ALLOWED_HOURS = new Set([
  // Mirror the TIME_FILTERS table in src/app/page.tsx — restrict the
  // accepted values so an attacker can't burn reads with arbitrary
  // queries.
  5 / 60, 10 / 60, 0.5, 1, 3, 6, 24, 72, 168, 720, 2160, 4320, 8760, 87600,
]);
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
  const hoursRaw = Number(searchParams.get("hours"));

  if (!CITY_RE.test(city)) {
    return NextResponse.json({ error: "invalid city" }, { status: 400 });
  }
  if (!Number.isFinite(hoursRaw) || !ALLOWED_HOURS.has(hoursRaw)) {
    return NextResponse.json({ error: "invalid hours" }, { status: 400 });
  }

  const sinceISO = new Date(Date.now() - hoursRaw * 3600_000).toISOString();

  try {
    const db = getAdminDb();
    const snap = await db
      .collection(COLLECTION)
      .where("city", "==", city)
      .where("reported_at", ">=", sinceISO)
      .count()
      .get();
    const count = snap.data().count;

    return NextResponse.json(
      { city, hours: hoursRaw, sinceISO, count },
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
    return NextResponse.json(
      { error: "count failed", detail: msg },
      { status: 500 },
    );
  }
}
