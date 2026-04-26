import type { Metadata } from "next";
import Link from "next/link";
import MarketingPageShell from "@/components/MarketingPageShell";
import { USE_CASE_SLUGS, USE_CASE_CAMPAIGNS } from "@/lib/use-case-campaigns";

const siteName = process.env.NEXT_PUBLIC_SITE_NAME || "PHLPulse";

export const metadata: Metadata = {
  title: `Use cases and campaign pages | ${siteName}`,
  description: `Shareable URLs for logistics routing, newsroom keyword alerts, venue awareness, research, and pilot API access on ${siteName}. Each page links into the live product.`,
  openGraph: {
    title: `Use cases | ${siteName}`,
    description: `Campaign pages that open the map, feed, alerts, and sign-in.`,
    type: "website",
  },
};

export default function UseCasesIndexPage() {
  return (
    <MarketingPageShell>
      <div className="lp-usecases" style={{ paddingTop: 8, maxWidth: 900, margin: "0 auto" }}>
        <div className="lp-stat-label" style={{ textAlign: "center" }}>
          Campaign pages
        </div>
        <h1 className="lp-usecases-title" style={{ textAlign: "center" }}>
          Use cases
        </h1>
        <p className="lp-usecases-sub" style={{ margin: "0 auto 28px", textAlign: "center", maxWidth: 640 }}>
          Distinct URLs for decks, ads, and partner email. Each page is <strong>marketing plus deep links</strong> into
          the same map and settings, not a separate product line.
        </p>
        <div className="lp-usecases-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {USE_CASE_SLUGS.map((slug) => {
            const c = USE_CASE_CAMPAIGNS[slug];
            return (
              <Link
                key={slug}
                href={`/use-cases/${slug}`}
                className="lp-usecase-card block no-underline hover:no-underline"
                style={{ color: "inherit" }}
              >
                <div className="lp-usecase-top">
                  <div className="lp-usecase-name">{c.cardTitle}</div>
                  {c.pro && <span className="lp-usecase-badge">Pro</span>}
                </div>
                <p className="lp-usecase-body" style={{ margin: 0 }}>
                  {c.metaDescription.slice(0, 120)}
                  {c.metaDescription.length > 120 ? "…" : ""}
                </p>
                <span style={{ fontSize: 12, color: "rgb(var(--accent-rgb))", marginTop: 10, display: "inline-block" }}>
                  Open page →
                </span>
              </Link>
            );
          })}
        </div>
        <p className="lp-usecases-note" style={{ marginTop: 32, textAlign: "center" }}>
          Hub:{" "}
          <Link href="/teams" style={{ color: "rgb(var(--accent-rgb))", textDecoration: "underline", textUnderlineOffset: 3 }}>
            Teams &amp; partners
          </Link>
        </p>
      </div>
    </MarketingPageShell>
  );
}
