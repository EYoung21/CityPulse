import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import SharedListPreview from "@/components/SharedListPreview";
import { decodeListToken } from "@/lib/share-list";
import { trustedRequestOrigin } from "@/lib/request-origin";
import { strictSingleSearchParam, type SearchParamValue } from "@/lib/share-params";
import {
  citySiteName,
  getCityForRequestHost,
  type PulseCity,
} from "@/lib/pulse-cities";

interface SearchParams {
  /** Encoded list-share token. */
  t?: SearchParamValue;
}

interface Props {
  searchParams: Promise<SearchParams>;
}

async function requestContext(): Promise<{ origin: string; city: PulseCity }> {
  const h = await headers();
  const host = h.get("host");
  return {
    origin: trustedRequestOrigin(host),
    city: getCityForRequestHost(host),
  };
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = await searchParams;
  const token = strictSingleSearchParam(sp.t, 32_000);
  const { origin, city } = await requestContext();
  const decoded = token ? decodeListToken(token) : null;

  const cityName = city.name;
  const brand = citySiteName(city);
  const senderLabel = decoded?.senderName?.trim() || "Someone";
  const itemCount = decoded?.items.length ?? 0;
  const listName = decoded?.listName || "Saved places";

  const title = decoded
    ? `${senderLabel} shared "${listName}" · ${itemCount} ${itemCount === 1 ? "place" : "places"}`
    : `Shared list · ${brand}`;
  const description = decoded
    ? `View ${itemCount} saved ${itemCount === 1 ? "place" : "places"} on the ${brand} safety map.`
    : `Real-time community-safety map for ${cityName}.`;

  // Reuse the generic OG card route. Accent stays in the brand-blue
  // family — these are friendly shares, not safety alerts.
  const ogParams = new URLSearchParams();
  ogParams.set("title", title);
  if (decoded) ogParams.set("location", `${itemCount} ${itemCount === 1 ? "place" : "places"} · ${cityName}`);
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
      siteName: brand,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogUrl],
    },
  };
}

/** Recipient page for "Share my saved list" links. Unlike the trip-share
 *  page (which auto-bounces into the live tracker), the list-share page
 *  pauses at a preview so the recipient can see what they're about to
 *  add to their account before they commit. The Import button is the
 *  client component since it needs Firebase + auth context. */
export default async function SharedListPage({ searchParams }: Props) {
  const sp = await searchParams;
  const { city } = await requestContext();
  const brand = citySiteName(city);
  const token = strictSingleSearchParam(sp.t, 32_000);
  const decoded = token ? decodeListToken(token) : null;

  if (!decoded) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
        <div className="max-w-md text-center">
          <p className="text-xs uppercase tracking-widest text-slate-500">{brand}</p>
          <h1 className="text-2xl font-bold mt-2">This share link is invalid</h1>
          <p className="text-sm text-slate-400 mt-3">
            The link may be incomplete, corrupted, or from a newer version of the app.
            Ask the sender for a fresh link.
          </p>
          <Link href="/" className="inline-block mt-6 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold">
            Open {brand}
          </Link>
        </div>
      </main>
    );
  }

  return <SharedListPreview snapshot={decoded} brand={brand} />;
}
