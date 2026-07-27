import { NextResponse } from "next/server";

const MAX_REPORT_BYTES = 8 * 1024;
const MAX_FIELD_LENGTH = 512;

function boundedText(value: unknown, maxLength = MAX_FIELD_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, maxLength);
}

function urlWithoutSecrets(value: unknown): string | undefined {
  const raw = boundedText(value, 2_048);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return parsed.protocol.slice(0, 32);
    }
    // Query strings and fragments can contain legacy share credentials.
    return `${parsed.origin}${parsed.pathname}`.slice(0, MAX_FIELD_LENGTH);
  } catch {
    return raw.split(/[?#]/, 1)[0].slice(0, MAX_FIELD_LENGTH);
  }
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

function sanitizedReport(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  const candidate = envelope["csp-report"] ?? envelope;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const report = candidate as Record<string, unknown>;

  const fields: Record<string, string | number | undefined> = {
    documentUri: urlWithoutSecrets(report["document-uri"] ?? report.documentURL),
    blockedUri: urlWithoutSecrets(report["blocked-uri"] ?? report.blockedURL),
    sourceFile: urlWithoutSecrets(report["source-file"] ?? report.sourceFile),
    effectiveDirective: boundedText(
      report["effective-directive"] ?? report.effectiveDirective,
      128,
    ),
    violatedDirective: boundedText(
      report["violated-directive"] ?? report.violatedDirective,
      128,
    ),
    disposition: boundedText(report.disposition, 32),
    lineNumber: finiteInteger(report["line-number"] ?? report.lineNumber),
    columnNumber: finiteInteger(report["column-number"] ?? report.columnNumber),
    statusCode: finiteInteger(report["status-code"] ?? report.statusCode),
  };

  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string | number] => entry[1] !== undefined),
  );
}

export async function POST(request: Request): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REPORT_BYTES) {
    return NextResponse.json({ error: "Report too large" }, { status: 413 });
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REPORT_BYTES) {
    return NextResponse.json({ error: "Report too large" }, { status: 413 });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const report = sanitizedReport(decoded);
  if (!report || Object.keys(report).length === 0) {
    return NextResponse.json({ error: "Invalid CSP report" }, { status: 400 });
  }

  // Vercel retains this only according to the deployment's normal runtime-log
  // settings; CityPulse does not add it to Firestore or another durable store.
  console.warn("[csp-report]", JSON.stringify(report));
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
