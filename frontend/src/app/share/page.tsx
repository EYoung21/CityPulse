import type { Metadata } from "next";
import { headers } from "next/headers";
import ShareRedirect from "@/components/ShareRedirect";

interface SearchParams {
  incident?: string;
  lat?: string;
  lng?: string;
  zoom?: string;
  /** Display title for the OG card. */
  t?: string;
  /** Severity category slug; drives the accent color in the OG card. */
  c?: string;
  /** Secondary line on the OG card (street, neighborhood). */
  loc?: string;
  /** ISO timestamp; rendered as "X min ago". */
  time?: string;
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

function buildOgUrl(origin: string, sp: SearchParams): string {
  const params = new URLSearchParams();
  if (sp.t) params.set("title", sp.t);
  if (sp.c) params.set("category", sp.c);
  if (sp.loc) params.set("location", sp.loc);
  if (sp.time) params.set("time", sp.time);
  return `${origin}/api/og?${params.toString()}`;
}

function buildAppUrl(origin: string, sp: SearchParams): string {
  const params = new URLSearchParams();
  if (sp.incident) params.set("incident", sp.incident);
  if (sp.lat) params.set("lat", sp.lat);
  if (sp.lng) params.set("lng", sp.lng);
  if (sp.zoom) params.set("zoom", sp.zoom);
  return `${origin}/?${params.toString()}`;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = await searchParams;
  const origin = await originFromHeaders();
  const cityName = process.env.NEXT_PUBLIC_CITY_NAME || "Philadelphia";
  const title = sp.t
    ? `${sp.t} — ${cityName} Pulse`
    : `${cityName} Pulse — Real-time Safety Map`;
  const description = sp.c
    ? `${sp.c.replace(/_/g, " ")} reported${sp.loc ? ` near ${sp.loc}` : ""}. Tap to open the live community-safety map.`
    : `Real-time AI-powered community safety map for ${cityName}.`;

  const ogUrl = origin ? buildOgUrl(origin, sp) : `/api/og?title=${encodeURIComponent(sp.t ?? "")}`;

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

/** Crawler-friendly bounce page. Social-link unfurlers see the metadata above
 *  (with a per-incident OG image); real users get a near-instant client-side
 *  redirect to the full app at `/?incident=<id>` (or `?lat=&lng=`). */
export default async function SharePage({ searchParams }: Props) {
  const sp = await searchParams;
  const origin = await originFromHeaders();
  const appUrl = buildAppUrl(origin, sp) || "/";
  const title = sp.t || "PhillyPulse";

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
          PhillyPulse
        </p>
        <h1 style={{ fontSize: 28, marginTop: 8, marginBottom: 0 }}>{title}</h1>
        <p style={{ color: "#94a3b8", marginTop: 16 }}>Opening the live map…</p>
        <p style={{ color: "#475569", marginTop: 24, fontSize: 12 }}>
          If you aren&apos;t redirected,{" "}
          <a href={appUrl} style={{ color: "#3b82f6" }}>tap here</a>.
        </p>
      </div>
    </div>
  );
}
