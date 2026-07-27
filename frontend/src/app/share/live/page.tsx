import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import LiveTripView from "@/components/LiveTripView";
import { isLiveShareId } from "@/lib/live-share-validation";
import { strictSingleSearchParam, type SearchParamValue } from "@/lib/share-params";
import { citySiteName, getCityForRequestHost } from "@/lib/pulse-cities";

interface SearchParams {
  /** 12-char base32 share ID. */
  id?: SearchParamValue;
}

interface Props {
  searchParams: Promise<SearchParams>;
}

/** OG metadata for live-share links. We can't peek at the live doc
 *  server-side without bundling firebase-admin (overkill), so the
 *  card is generic — recipients still get a useful preview when the
 *  link is pasted into iMessage or Slack. */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = await searchParams;
  const shareId = strictSingleSearchParam(sp.id, 64);
  const h = await headers();
  const city = getCityForRequestHost(h.get("host"));
  const cityName = city.name;
  const brand = citySiteName(city);

  if (!isLiveShareId(shareId)) {
    return {
      title: `${brand} · Live ETA`,
      description: `Watch a friend arrive in real time on the ${brand} safety map.`,
    };
  }

  const title = `Live ETA · someone is on their way`;
  const description = `Watch their position update in real time on the ${brand} safety map.`;
  const ogParams = new URLSearchParams();
  ogParams.set("title", title);
  ogParams.set("location", `${cityName} · live`);
  const ogUrl = `/api/og?${ogParams.toString()}`;

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
    // Live links are short-lived; tell crawlers not to index.
    robots: { index: false, follow: false },
  };
}

export default async function SharedLivePage({ searchParams }: Props) {
  const sp = await searchParams;
  const h = await headers();
  const city = getCityForRequestHost(h.get("host"));
  const brand = citySiteName(city);
  const shareId = strictSingleSearchParam(sp.id, 64);

  if (!isLiveShareId(shareId)) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
        <div className="max-w-md text-center">
          <p className="text-xs uppercase tracking-widest text-slate-500">{brand}</p>
          <h1 className="text-2xl font-bold mt-2">Invalid live share</h1>
          <p className="text-sm text-slate-400 mt-3">
            This link is missing a valid share ID or has expired. Ask the sender for a fresh link.
          </p>
          <Link href="/" className="inline-block mt-6 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold">
            Open {brand}
          </Link>
        </div>
      </main>
    );
  }

  return <LiveTripView shareId={shareId} brand={brand} />;
}
