import { NextResponse } from "next/server";

/**
 * Closed-tab Web Push was served by the retired Python backend. Keep this
 * capability probe same-origin and explicit so opening notification settings
 * never waits on, or proxies to, the offline origin.
 */
export function GET() {
  return NextResponse.json(
    {
      configured: false,
      publicKey: null,
      reason: "push-backend-paused",
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
      },
    },
  );
}
