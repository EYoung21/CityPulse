import { NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy } from "@/lib/content-security-policy";

function requestNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

/**
 * Firebase `signInWithPopup` (and Google's helper) reads `popup.closed` from the
 * opener. Browsers enforce COOP on that relationship; `same-origin` blocks it.
 * `same-origin-allow-popups` keeps hardening while allowing OAuth popups.
 *
 * We also attach the per-request CSP nonce here. Production script execution
 * requires the nonce; inline styles remain temporarily allowed while the
 * component-style migration proceeds.
 */
export function proxy(request: NextRequest) {
  const nonce = requestNonce();
  const policy = contentSecurityPolicy({ nonce });
  const requestHeaders = new Headers(request.headers);
  // Next parses this request header and adds the nonce to framework scripts.
  requestHeaders.set("Content-Security-Policy", policy);
  requestHeaders.set("x-nonce", nonce);

  const res = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.headers.set("Content-Security-Policy", policy);
  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
