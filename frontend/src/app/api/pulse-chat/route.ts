import { NextRequest, NextResponse } from "next/server";
import {
  CITY_RE,
  effectiveSince,
  readIncidentWindow,
  resolveEntitlement,
} from "@/lib/server-incidents";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Ask Pulse — Pro-only chat grounded in the city's recent incidents.
 *
 * The original implementation lived on the retired FastAPI backend
 * (Bedrock/DeepSeek RAG over Firestore). This route restores the feature
 * serverlessly: pull the incident window from Firestore, pack a compact
 * context table into the system prompt, and call an OpenAI-compatible
 * chat API. Responses reuse the exact shape `normalizePulseChatResponse`
 * expects, so the panel works unchanged.
 *
 * Model config comes from env so the provider can be swapped without a
 * code change:
 *   PULSE_CHAT_API_BASE  (default https://api.deepseek.com/v1)
 *   PULSE_CHAT_API_KEY   (falls back to DEEPSEEK_API_KEY)
 *   PULSE_CHAT_MODEL     (default deepseek-v4-flash)
 */

const MAX_CONTEXT_INCIDENTS = 150;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4_000;

type ChatMessage = { role: "user" | "assistant"; content: string };

function sanitizeMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const row of value.slice(-MAX_MESSAGES)) {
    if (!row || typeof row !== "object") return null;
    const role = (row as { role?: unknown }).role;
    const content = (row as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string" || !content.trim()) return null;
    out.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return out.length > 0 && out[out.length - 1].role === "user" ? out : null;
}

function contextLine(row: Record<string, unknown>): string {
  const time = String(row.reported_at || "").slice(0, 16).replace("T", " ");
  const category = String(row.severity_category || "unknown");
  const description = String(row.description || row.raw_text || "")
    .replace(/\s+/g, " ")
    .slice(0, 90);
  const location = String(row.location_text || "unknown location").slice(0, 70);
  return `${row.id} | ${time} | ${category} | ${description} | ${location}`;
}

export async function POST(request: NextRequest) {
  const apiKey =
    process.env.PULSE_CHAT_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { detail: "Ask Pulse is not configured on this deployment." },
      { status: 503 },
    );
  }

  const entitlement = await resolveEntitlement(request);
  if (!entitlement.authenticated) {
    return NextResponse.json({ detail: "Sign in required" }, { status: 401 });
  }
  if (!entitlement.isPro) {
    return NextResponse.json(
      { detail: "CityPulse Pro is required for Ask Pulse." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }
  const record = (body || {}) as Record<string, unknown>;
  const city = String(record.city || "").trim().toLowerCase();
  if (!CITY_RE.test(city)) {
    return NextResponse.json({ detail: "invalid city" }, { status: 400 });
  }
  const messages = sanitizeMessages(record.messages);
  if (!messages) {
    return NextResponse.json({ detail: "invalid messages" }, { status: 400 });
  }
  const requestedSince =
    typeof record.since === "string" && Number.isFinite(Date.parse(record.since))
      ? record.since
      : null;

  try {
    const { since } = effectiveSince(requestedSince, true);
    const incidents = await readIncidentWindow({
      city,
      since,
      limit: 1_000,
    });
    const context = incidents.slice(0, MAX_CONTEXT_INCIDENTS);

    const system = [
      "You are Ask Pulse, the incident analyst for CityPulse — a public-safety",
      `map of ${city}. Answer questions using ONLY the incident table below.`,
      "Incidents are unverified reports from public government sources, not",
      "confirmed news; say so when relevant. Never invent incidents, counts,",
      "or locations. When you reference a specific incident, cite it inline",
      "as [[INC:<id>]] using the id column. Keep answers concise and factual;",
      "give counts and time ranges where useful. If the table cannot answer",
      "the question, say what is missing instead of guessing.",
      "",
      `INCIDENTS (${context.length} most recent of ${incidents.length} in window, since ${since}):`,
      "id | reported_at | category | description | location",
      ...context.map(contextLine),
    ].join("\n");

    const base = (
      process.env.PULSE_CHAT_API_BASE || "https://api.deepseek.com/v1"
    ).replace(/\/$/, "");
    const model = process.env.PULSE_CHAT_MODEL || "deepseek-v4-flash";
    const upstream = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, ...messages],
        temperature: 0.2,
        // DeepSeek v4 models are reasoning models: without disabling
        // thinking they can spend the whole token budget on hidden
        // reasoning and return EMPTY content (verified live). Grounded
        // table lookups don't need chain-of-thought; disable it. The
        // param is ignored by providers that don't know it.
        thinking: { type: "disabled" },
        max_tokens: 1_600,
        stream: false,
      }),
      signal: AbortSignal.timeout(50_000),
    });
    if (upstream.status === 429) {
      return NextResponse.json(
        { detail: "Ask Pulse is briefly rate-limited upstream." },
        { status: 429 },
      );
    }
    if (!upstream.ok) {
      throw new Error(`chat upstream HTTP ${upstream.status}`);
    }
    const completion = (await upstream.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const reply = completion.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error("chat upstream returned no content");

    // Resolve inline [[INC:<id>]] markers to citation rows + full incidents
    // so the panel can render its inline cards.
    const citedIds = [
      ...new Set(
        [...reply.matchAll(/\[\[INC:([A-Za-z0-9_-]{1,100})\]\]/g)].map(
          (match) => match[1],
        ),
      ),
    ].slice(0, 100);
    const byId = new Map(context.map((row) => [row.id, row]));
    const citedIncidents = citedIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });

    return NextResponse.json({
      reply,
      citations: citedIncidents.map((row) => ({
        id: row.id,
        reported_at:
          typeof row.reported_at === "string" ? row.reported_at : null,
        category:
          typeof row.severity_category === "string"
            ? row.severity_category
            : null,
      })),
      cited_incidents: citedIncidents,
      meta: {
        city,
        effective_since: since,
        incidents_in_context: context.length,
        incidents_fetched: incidents.length,
        truncated: incidents.length > context.length,
        fetch_cap: MAX_CONTEXT_INCIDENTS,
        tools_enabled: false,
      },
    });
  } catch (error) {
    console.error("[/api/pulse-chat] failed", {
      city,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { detail: "Ask Pulse is temporarily unavailable." },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
}
