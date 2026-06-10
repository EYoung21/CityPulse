import { NextRequest, NextResponse } from "next/server";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function ensureAdmin() {
  if (getApps().length === 0) {
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (process.env.FIREBASE_ADMIN_KEY) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_ADMIN_KEY)) });
    } else {
      initializeApp({ projectId });
    }
  }
  return getAuth();
}

// Best-effort per-IP rate limit. NOTE: this is intentionally simple and
// PER-INSTANCE — the Map lives in the memory of a single Node server
// process, so it does NOT coordinate across multiple instances/regions
// and resets on cold start. It exists to blunt trivial abuse (someone
// hammering this endpoint to grind out custom tokens) cheaply. A durable,
// cross-instance limiter (e.g. Upstash Redis) is the production-grade
// follow-up.
const RATE_LIMIT_MAX = 10; // requests
const RATE_LIMIT_WINDOW_MS = 60_000; // per 60s, per IP
const rateLimitBuckets = new Map<string, { count: number; windowStart: number }>();

function clientIp(req: NextRequest): string {
  // First hop in x-forwarded-for is the originating client; fall back to
  // x-real-ip. "unknown" is a safe shared bucket if neither is present.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Returns true if this IP is over its limit for the current window. */
function isRateLimited(ip: string): boolean {
  // A plain timestamp read at request time is the correct window clock
  // here — monotonic-enough for a fixed-window counter, and Date.now()
  // matches the millisecond units used elsewhere in this codebase.
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

/**
 * Exchange a Firebase ID token for a custom token.
 * Used for cross-domain auth: user signed in on 423pulse.com navigates
 * to newyorkcitypulse.com, and the receiving site uses this endpoint
 * to mint a custom token so signInWithCustomToken() can restore the session.
 */
export async function POST(req: NextRequest) {
  try {
    // The custom token minted below grants a durable session (the
    // receiving site calls signInWithCustomToken, which yields a fresh,
    // long-lived refresh token). Because it's a session-bearing
    // credential, we harden the exchange itself: a per-IP rate limit to
    // throttle abuse, and check-revoked verification so a token from a
    // signed-out / disabled / revoked session can't be laundered into a
    // new session here.
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      return NextResponse.json({ error: "rate limited" }, { status: 429 });
    }

    const { idToken } = (await req.json()) as { idToken?: string };
    if (!idToken) {
      return NextResponse.json({ error: "idToken required" }, { status: 400 });
    }

    const auth = ensureAdmin();
    // Second arg = checkRevoked: forces a check against the user's
    // tokensValidAfterTime / disabled state so revoked sessions are
    // rejected (throws -> 401 below) instead of being exchanged.
    const decoded = await auth.verifyIdToken(idToken, true);
    const customToken = await auth.createCustomToken(decoded.uid);

    return NextResponse.json({ customToken });
  } catch (err) {
    console.error("Token exchange failed:", err);
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }
}
