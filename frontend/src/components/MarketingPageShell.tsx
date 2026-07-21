import Link from "next/link";
import "@/app/landing/landing.css";
import MarketingHeaderActions from "@/components/MarketingHeaderActions";

interface Props {
  children: React.ReactNode;
}

/**
 * Shared chrome for lightweight marketing routes (`/teams`, `/use-cases/*`).
 * The right-side CTA flips between "Create Account / Sign In" (signed-out)
 * and the user's name + "Open app" (signed-in) — see [[MarketingHeaderActions]].
 */
export default function MarketingPageShell({ children }: Props) {
  return (
    <div className="landing-page min-h-screen flex flex-col">
      <header className="lp-header">
        <Link href="/" className="lp-header-brand" aria-label="CityPulse home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="lp-header-logo" />
          <span className="lp-header-wordmark">CityPulse</span>
        </Link>
        <div className="lp-header-actions">
          <MarketingHeaderActions />
        </div>
      </header>

      <main className="flex-1" style={{ paddingTop: "100px", paddingBottom: "48px" }}>
        {children}
      </main>

      <footer className="lp-cta" style={{ padding: "2rem 24px 3rem", marginTop: "auto" }}>
        <p className="lp-footer-note" style={{ margin: 0, textAlign: "center" }}>
          <Link href="/use-cases" style={{ color: "rgb(var(--accent-rgb))", marginRight: "1rem" }}>
            Use case pages
          </Link>
          <Link href="/teams" style={{ color: "rgb(var(--accent-rgb))", marginRight: "1rem" }}>
            Teams hub
          </Link>
          <Link href="/" style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}>
            Map
          </Link>
          {" · "}© {new Date().getFullYear()} {process.env.NEXT_PUBLIC_SITE_NAME || "CityPulse"}
        </p>
      </footer>
    </div>
  );
}
