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

/**
 * Exchange a Firebase ID token for a custom token.
 * Used for cross-domain auth: user signed in on 423pulse.com navigates
 * to newyorkcitypulse.com, and the receiving site uses this endpoint
 * to mint a custom token so signInWithCustomToken() can restore the session.
 */
export async function POST(req: NextRequest) {
  try {
    const { idToken } = (await req.json()) as { idToken?: string };
    if (!idToken) {
      return NextResponse.json({ error: "idToken required" }, { status: 400 });
    }

    const auth = ensureAdmin();
    const decoded = await auth.verifyIdToken(idToken);
    const customToken = await auth.createCustomToken(decoded.uid);

    return NextResponse.json({ customToken });
  } catch (err) {
    console.error("Token exchange failed:", err);
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }
}
