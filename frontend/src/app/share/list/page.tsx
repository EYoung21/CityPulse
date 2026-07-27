import type { Metadata } from "next";
import { headers } from "next/headers";
import SharedListFragmentPage from "@/components/SharedListFragmentPage";
import { trustedRequestOrigin } from "@/lib/request-origin";
import {
  citySiteName,
  getCityForRequestHost,
  type PulseCity,
} from "@/lib/pulse-cities";

async function requestContext(): Promise<{ origin: string; city: PulseCity }> {
  const h = await headers();
  const host = h.get("host");
  return {
    origin: trustedRequestOrigin(host),
    city: getCityForRequestHost(host),
  };
}

/** Share secrets live in URL fragments, which crawlers and the server cannot
 * read. Metadata is intentionally generic so private list details never enter
 * request logs or social-preview infrastructure. */
export async function generateMetadata(): Promise<Metadata> {
  const { origin, city } = await requestContext();
  const brand = citySiteName(city);
  const title = `Shared list · ${brand}`;
  const description = `Open a private shared list on the ${brand} safety map.`;
  const ogParams = new URLSearchParams({ title, location: city.name });
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
    robots: { index: false, follow: false },
  };
}

export default async function SharedListPage() {
  const { city } = await requestContext();
  return <SharedListFragmentPage brand={citySiteName(city)} />;
}
