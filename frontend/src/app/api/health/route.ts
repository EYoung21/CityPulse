import { NextResponse } from "next/server";
import { ensureAdmin } from "@/lib/server-incidents";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { db } = ensureAdmin();
    const result = await db.collection("incidents").count().get();
    return NextResponse.json(
      {
        status: "ok",
        database_ok: true,
        incident_api: "vercel-firestore",
        ingestion: "structured-public-sources",
        llm_configured: false,
        pulse_chat_llm_configured: false,
        inhibitor_configured: true,
        incident_count: result.data().count,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
        },
      },
    );
  } catch (error) {
    console.error("[/api/health] Firestore health check failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      {
        status: "degraded",
        database_ok: false,
        incident_api: "unavailable",
        ingestion: "structured-public-sources",
        llm_configured: false,
        pulse_chat_llm_configured: false,
        inhibitor_configured: true,
        incident_count: -1,
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "30",
        },
      },
    );
  }
}
