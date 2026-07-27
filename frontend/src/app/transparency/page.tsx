import type { Metadata } from "next";
import { headers } from "next/headers";
import TransparencyClient from "./TransparencyClient";
import { citySiteName, getCityForRequestHost } from "@/lib/pulse-cities";

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const city = getCityForRequestHost(h.get("host"));
  const brand = citySiteName(city);
  return {
    title: `Community moderation transparency · ${brand}`,
    description: `How crowdsourced reports are validated, voted on, and moderated on ${brand} over the last 30 days.`,
    openGraph: {
      title: `${brand} · Community moderation transparency`,
      description: `Open numbers on report verification, auto-hiding, and moderator activity.`,
      type: "website",
    },
  };
}

export default async function TransparencyPage() {
  const h = await headers();
  const city = getCityForRequestHost(h.get("host"));
  return <TransparencyClient brand={citySiteName(city)} />;
}
