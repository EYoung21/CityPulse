import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import MarketingPageShell from "@/components/MarketingPageShell";
import ApiDocsSection from "@/components/ApiDocsSection";
import { USE_CASE_SLUGS, getCampaign } from "@/lib/use-case-campaigns";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return USE_CASE_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const c = getCampaign(slug);
  if (!c) {
    return { title: "Use case · CityPulse" };
  }
  return {
    title: c.pageTitle,
    description: c.metaDescription,
    openGraph: {
      title: c.pageTitle,
      description: c.metaDescription,
      type: "website",
    },
  };
}

function RichParagraph({ text }: { text: string }) {
  const parts = text.split(/\*\*/);
  return (
    <p className="lp-usecases-sub" style={{ margin: "0 0 16px", textAlign: "left", maxWidth: 720 }}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong key={i} style={{ color: "rgba(255,255,255,0.92)" }}>
            {part}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </p>
  );
}

export default async function UseCaseCampaignPage({ params }: PageProps) {
  const { slug } = await params;
  const c = getCampaign(slug);
  if (!c) notFound();

  return (
    <MarketingPageShell>
      <article className="lp-usecases" style={{ maxWidth: 760, margin: "0 auto", padding: "0 24px" }}>
        <p className="lp-stat-label" style={{ marginBottom: 8 }}>
          <Link href="/use-cases" style={{ color: "rgb(var(--accent-rgb))" }}>
            ← All use cases
          </Link>
        </p>
        {c.pro && (
          <span className="lp-usecase-badge" style={{ marginBottom: 10, display: "inline-block" }}>
            Pro
          </span>
        )}
        <h1
          className="lp-usecases-title"
          style={{ margin: "0 0 16px", fontSize: "clamp(1.5rem, 4vw, 2.25rem)", lineHeight: 1.15 }}
        >
          {c.headline}
        </h1>
        {c.paragraphs.map((p, i) => (
          <RichParagraph key={i} text={p} />
        ))}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginTop: 8, marginBottom: 16 }}>
          {c.ctas.map((cta) => (
            <Link key={cta.href + cta.label} href={cta.href} className="lp-hero-cta" style={{ display: "inline-block", marginTop: 0 }}>
              {cta.label}
            </Link>
          ))}
        </div>
        {c.footnote && (
          <p className="lp-usecases-note" style={{ textAlign: "left", marginTop: 8 }}>
            {c.footnote}
          </p>
        )}
        {/* Per-slug deep content. `api` extends the marketing header with a
            real developer reference (endpoints, auth, rate-limit caveats).
            Other slugs keep the default marketing-only layout. */}
        {slug === "api" && <ApiDocsSection />}
        <p className="lp-usecases-note" style={{ marginTop: 24, textAlign: "left" }}>
          More:{" "}
          <Link href="/teams" style={{ color: "rgb(var(--accent-rgb))", textDecoration: "underline", textUnderlineOffset: 3 }}>
            Teams hub
          </Link>
          {" · "}
          <Link href="/" style={{ color: "rgb(var(--accent-rgb))", textDecoration: "underline", textUnderlineOffset: 3 }}>
            Live map
          </Link>
        </p>
      </article>
    </MarketingPageShell>
  );
}
