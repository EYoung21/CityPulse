type CspOptions = {
  nonce: string;
};

function serializePolicy(directives: Array<string | false>): string {
  return directives.filter((directive): directive is string => Boolean(directive)).join("; ");
}

/**
 * Enforced per-request policy.
 *
 * Next reads the nonce from the request header and applies it to framework
 * scripts on dynamically rendered pages. Production has neither `unsafe-eval`
 * nor script `unsafe-inline`; development needs `unsafe-eval` for React/Next
 * debugging. Inline styles remain temporarily allowed because map overlays and
 * several React components still use style attributes.
 */
export function contentSecurityPolicy({ nonce }: CspOptions): string {
  return serializePolicy([
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com${
      process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
    }`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data: https:",
    "connect-src 'self' https: wss:",
    "frame-src https://js.stripe.com https://*.firebaseapp.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "report-uri /api/csp-report",
    process.env.NODE_ENV === "production" && "upgrade-insecure-requests",
  ]);
}
