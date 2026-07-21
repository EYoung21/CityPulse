import { maybeIdToken } from "@/lib/api";
import { fetchPublicApi } from "@/lib/public-api-base";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

const MAX_ADMIN_TICKET_RESPONSE_BYTES = 64 * 1024;

export type AdminTicketPurpose = "ws" | "stream" | "raw_audio";

/** Exchange a Firebase admin credential in an Authorization header for a
 * one-shot, narrowly scoped transport ticket. The returned ticket is safe to
 * place in the native WebSocket/<audio> URL because it cannot call any admin
 * API and expires within seconds. */
export async function requestAdminTicket(
  purpose: AdminTicketPurpose,
  resourceId?: string
): Promise<string | null> {
  const idToken = await maybeIdToken();
  if (!idToken) return null;
  try {
    const response = await fetchPublicApi("/api/admin/ticket", {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        purpose,
        ...(purpose === "stream" ? { feed_id: resourceId } : {}),
        ...(purpose === "raw_audio" ? { clip_id: resourceId } : {}),
      }),
    });
    if (!response.ok) return null;
    const raw = await readBoundedJsonResponse(response, MAX_ADMIN_TICKET_RESPONSE_BYTES);
    const data = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : null;
    return typeof data?.ticket === "string" && data.ticket.length <= 8_192
      ? data.ticket
      : null;
  } catch {
    return null;
  }
}
