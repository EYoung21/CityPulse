import { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import NeighborhoodProfile from "@/components/NeighborhoodProfile";
import Providers from "@/components/Providers";
import { getCityForRequestHost } from "@/lib/pulse-cities";
import { getServerNeighborhoodBySlug } from "@/lib/server-neighborhoods";

// Providers reads request headers at runtime (auth/theme), which conflicts with
// static prerendering of these slugs and 500s under `next start` with
// "Page changed from static to dynamic at runtime, reason: headers". Render the
// neighborhood pages dynamically so that never happens and so the CSP proxy
// can attach a fresh script nonce to every HTML response.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const city = getCityForRequestHost((await headers()).get("host"));
  const hood = await getServerNeighborhoodBySlug(city.slug, slug);
  const name = hood?.name ?? "Unknown";
  return {
    title: `${name} Safety Profile | CityPulse`,
    description: `Public-source safety data for ${name}. Incident trends, peak hours, and privacy-reduced history.`,
    openGraph: {
      title: `${name} · CityPulse Safety Profile`,
      description: `Live safety analytics for ${name}, ${city.name}.`,
    },
  };
}

export default async function NeighborhoodPage({ params }: PageProps) {
  const { slug } = await params;
  const city = getCityForRequestHost((await headers()).get("host"));
  const hood = await getServerNeighborhoodBySlug(city.slug, slug);
  if (!hood) notFound();

  return (
    <Providers>
      <NeighborhoodProfile slug={slug} />
    </Providers>
  );
}
