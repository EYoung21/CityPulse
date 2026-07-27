import type { Metadata } from "next";
import { headers } from "next/headers";
import SharedLiveFragmentPage from "@/components/SharedLiveFragmentPage";
import { citySiteName, getCityForRequestHost } from "@/lib/pulse-cities";

/** Live-share IDs are fragment-only, so the server and social crawlers receive
 * a generic preview and never see the Firestore document bearer. */
export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const city = getCityForRequestHost(h.get("host"));
  const brand = citySiteName(city);
  const title = `Live ETA · ${brand}`;
  const description = `Watch a friend arrive in real time on the ${brand} safety map.`;
  const ogParams = new URLSearchParams({ title, location: `${city.name} · live` });
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
    robots: { index: false, follow: false },
  };
}

export default async function SharedLivePage() {
  const h = await headers();
  const city = getCityForRequestHost(h.get("host"));
  return <SharedLiveFragmentPage brand={citySiteName(city)} />;
}
