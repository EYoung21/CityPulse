import type { Metadata } from "next";
import TransparencyClient from "./TransparencyClient";

const cityName =
  process.env.NEXT_PUBLIC_CITY_NAME?.trim() || "Philadelphia";

export const metadata: Metadata = {
  title: `Community moderation transparency — ${cityName} Pulse`,
  description: `How crowdsourced reports are validated, voted on, and moderated on ${cityName} Pulse over the last 30 days.`,
  openGraph: {
    title: `${cityName} Pulse — Community moderation transparency`,
    description: `Open numbers on report verification, auto-hiding, and moderator activity.`,
    type: "website",
  },
};

export default function TransparencyPage() {
  return <TransparencyClient />;
}
