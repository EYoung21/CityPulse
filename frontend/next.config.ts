import type { NextConfig } from "next";

/** FastAPI origin (no trailing slash). On Vercel this must be set or `/api/*` rewrites miss the backend. */
const BACKEND_URL = (process.env.BACKEND_URL || "http://127.0.0.1:8765").replace(/\/$/, "");

if (process.env.VERCEL === "1") {
  const raw = process.env.BACKEND_URL?.trim() || "";
  if (!raw || /127\.0\.0\.1|localhost/i.test(raw)) {
    console.warn(
      "[next.config] Vercel: set BACKEND_URL to your FastAPI origin (e.g. https://api.phlpulse.com) with no trailing slash. " +
        "If it is missing or still localhost, same-origin fetches to /api/incidents (etc.) 404 at the edge.",
    );
  }
}

const nextConfig: NextConfig = {
  async headers() {
    // Firebase Auth (Google popup) polls `popup.closed` / calls `window.close()`.
    // When COOP is too strict, browsers block that access and auth appears to hang.
    // Allow popups to keep the opener relationship for auth flows.
    return [
      {
        // `/(.*)` matches root + all paths (some Next/Vercel combos are picky about `/:path*`)
        source: "/(.*)",
        headers: [
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
        ],
      },
    ];
  },
  async rewrites() {
    // afterFiles: real Next.js routes (e.g. app/api/route-directions) win first;
    // only unmatched /api/* goes to the Python backend.
    return {
      afterFiles: [
        {
          // FastAPI WebSocket routes live under `/ws/*`, not `/api/*`.
          // Without this, the admin panel connects to the Next origin and the upgrade never reaches Python.
          source: "/ws/:path*",
          destination: `${BACKEND_URL}/ws/:path*`,
        },
        {
          source: "/api/:path*",
          destination: `${BACKEND_URL}/api/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
