import type { Metadata } from "next";
import LiveTripView from "@/components/LiveTripView";

interface SearchParams {
  /** 12-char base32 share ID. */
  id?: string;
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
  const cityName = process.env.NEXT_PUBLIC_CITY_NAME || "Philadelphia";

  if (!sp.id) {
    return {
      title: `${cityName} Pulse · Live ETA`,
      description: `Watch a friend arrive in real time on the ${cityName} Pulse safety map.`,
    };
  }

  const title = `Live ETA · someone is on their way`;
  const description = `Watch their position update in real time on the ${cityName} Pulse safety map.`;
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
      siteName: "PhillyPulse",
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

  if (!sp.id) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
        <div className="max-w-md text-center">
          <p className="text-xs uppercase tracking-widest text-slate-500">PhillyPulse</p>
          <h1 className="text-2xl font-bold mt-2">No live share specified</h1>
          <p className="text-sm text-slate-400 mt-3">
            The link is missing the share ID. Ask the sender for a fresh link.
          </p>
          <a href="/" className="inline-block mt-6 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold">
            Open PhillyPulse
          </a>
        </div>
      </div>
    );
  }

  return <LiveTripView shareId={sp.id} />;
}
