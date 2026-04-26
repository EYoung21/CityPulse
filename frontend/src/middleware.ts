import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Firebase `signInWithPopup` (and Google's helper) reads `popup.closed` from the
 * opener. Browsers enforce COOP on that relationship; `same-origin` blocks it.
 * `same-origin-allow-popups` keeps hardening while allowing OAuth popups.
 *
 * We set this in middleware so every HTML route gets the header at the edge
 * (belt-and-suspenders with `next.config.ts`).
 */
export function middleware(_request: NextRequest) {
  const res = NextResponse.next();
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
