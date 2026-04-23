import type { Metadata } from "next";
import { headers } from "next/headers";
import ShareRedirect from "@/components/ShareRedirect";
import { decodeTripToken } from "@/lib/share-trip";

interface SearchParams {
  /** Encoded trip-share token. */
  t?: string;
}

interface Props {
  searchParams: Promise<SearchParams>;
}

async function originFromHeaders(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") || "https";
  const host = h.get("host") || "";
  return host ? `${proto}://${host}` : "";
}

function fmtRemaining(ms: number): string {
  if (ms <= 0) return "arriving now";
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return `~${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `~${h}h` : `~${h}h ${m}m`;
}

const MODE_VERB: Record<string, string> = {
  "foot-walking":   "walking",
  "cycling-regular": "biking",
  "driving-car":    "driving",
};

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = await searchParams;
  const origin = await originFromHeaders();
  const decoded = sp.t ? decodeTripToken(sp.t) : null;

  const cityName = process.env.NEXT_PUBLIC_CITY_NAME || "Philadelphia";
  const senderLabel = decoded?.name?.trim() || "Someone";
  const verb = decoded ? (MODE_VERB[decoded.mode] || "heading") : "heading";
  const remaining = decoded ? fmtRemaining(decoded.etaEpochMs - Date.now()) : "";
  const title = decoded
    ? `${senderLabel} is ${verb} · ETA ${remaining}`
    : `Live ETA · ${cityName} Pulse`;
  const description = decoded
    ? `Track ${senderLabel}'s live ETA on the ${cityName} Pulse safety map.`
    : `Real-time AI-powered community safety map for ${cityName}.`;

  // Reuse the generic OG card. We pass `category=other` so the accent stays
  // in the brand-blue family rather than alarm-red.
  const ogParams = new URLSearchParams();
  ogParams.set("title", title);
  if (decoded) ogParams.set("location", `Heading to ${decoded.destination[0].toFixed(3)}, ${decoded.destination[1].toFixed(3)}`);
  const ogUrl = origin
    ? `${origin}/api/og?${ogParams.toString()}`
    : `/api/og?${ogParams.toString()}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: ogUrl, width: 1200, height: 630, alt: title }],
      type: "website",
      siteName: "PhillyPulse",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogUrl],
    },
  };
}

/** Crawler-friendly bounce page for "Share my live ETA" links. The token
 *  itself is opaque; this server component just generates the rich OG
 *  preview and forwards real users to `/?trip=<token>`, which the main
 *  app decodes and renders as a tracking card + dashed cyan polyline. */
export default async function SharedTripPage({ searchParams }: Props) {
  const sp = await searchParams;
  const origin = await originFromHeaders();
  const appUrl = sp.t
    ? `${origin}/?trip=${encodeURIComponent(sp.t)}`
    : `${origin}/`;
  const decoded = sp.t ? decodeTripToken(sp.t) : null;
  const senderLabel = decoded?.name?.trim() || "Someone";
  const remaining = decoded ? fmtRemaining(decoded.etaEpochMs - Date.now()) : "";

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a14",
        color: "#fff",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <ShareRedirect appUrl={appUrl} />
      <div style={{ textAlign: "center", padding: 24, maxWidth: 480 }}>
        <p style={{ fontSize: 14, color: "#94a3b8", letterSpacing: 2, textTransform: "uppercase", margin: 0 }}>
          PhillyPulse · Live ETA
        </p>
        <h1 style={{ fontSize: 28, marginTop: 8, marginBottom: 0 }}>
          {decoded ? `${senderLabel} is on the way` : "Live ETA"}
        </h1>
        {decoded && (
          <p style={{ color: "#cbd5e1", marginTop: 8 }}>
            ETA {remaining}
          </p>
        )}
        <p style={{ color: "#94a3b8", marginTop: 16 }}>Opening the live map…</p>
        <p style={{ color: "#475569", marginTop: 24, fontSize: 12 }}>
          If you aren&apos;t redirected,{" "}
          <a href={appUrl} style={{ color: "#3b82f6" }}>tap here</a>.
        </p>
      </div>
    </div>
  );
}
