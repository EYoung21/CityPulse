import { Metadata } from "next";
import { getNeighborhoodBySlug, NEIGHBORHOODS } from "@/lib/neighborhoods";
import NeighborhoodProfile from "@/components/NeighborhoodProfile";
import Providers from "@/components/Providers";

// Providers reads request headers at runtime (auth/theme), which conflicts with
// static prerendering of these slugs and 500s under `next start` with
// "Page changed from static to dynamic at runtime, reason: headers". Render the
// neighborhood pages dynamically so that never happens. generateStaticParams
// still scopes which slugs are valid.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return NEIGHBORHOODS.map((n) => ({ slug: n.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const hood = getNeighborhoodBySlug(slug);
  const name = hood?.name ?? "Unknown";
  return {
    title: `${name} Safety Profile | CityPulse`,
    description: `Real-time safety data for ${name}. Crime trends, peak hours, and incident history powered by AI scanner analysis.`,
    openGraph: {
      title: `${name} · CityPulse Safety Profile`,
      description: `Live safety analytics for ${name}, Philadelphia.`,
    },
  };
}

export default async function NeighborhoodPage({ params }: PageProps) {
  const { slug } = await params;
  return (
    <Providers>
      <NeighborhoodProfile slug={slug} />
    </Providers>
  );
}
