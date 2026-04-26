import type { NextConfig } from "next";

const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8765";

const nextConfig: NextConfig = {
  async headers() {
    // Firebase Auth (Google popup) polls `popup.closed` / calls `window.close()`.
    // When COOP is too strict, browsers block that access and auth appears to hang.
    // Allow popups to keep the opener relationship for auth flows.
    return [
      {
        source: "/:path*",
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
          source: "/api/:path*",
          destination: `${BACKEND_URL}/api/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
