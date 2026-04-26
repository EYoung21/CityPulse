import type { Metadata } from "next";
import Link from "next/link";
import "../landing/landing.css";

const siteName = process.env.NEXT_PUBLIC_SITE_NAME || "PHLPulse";
const cityName = process.env.NEXT_PUBLIC_CITY_NAME?.trim() || "Philadelphia";

export const metadata: Metadata = {
  title: `Teams & partners · ${siteName}`,
  description: `How organizations use ${siteName} for delivery routing, keyword alerts, situational awareness, and pilot API access. One live map, not separate persona apps.`,
  openGraph: {
    title: `Teams & partners · ${siteName}`,
    description: `Deep links into the map, alert settings, and product scope for ${cityName} Pulse.`,
    type: "website",
  },
};

/**
 * Marketing hub for B2B-style use cases. The product is intentionally one
 * map and shared APIs, not parallel in-app “modes” per persona.
 */
export default function TeamsPage() {
  return (
    <div className="landing-page min-h-screen">
      <header className="lp-header">
        <Link href="/" className="lp-header-brand" aria-label="CityPulse home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="lp-header-logo" />
          <span className="lp-header-wordmark">CityPulse</span>
        </Link>
        <div className="lp-header-actions">
          <Link href="/login" className="lp-header-cta">
            Create Account / Sign In
          </Link>
        </div>
      </header>

      <main className="lp-teams-page-main" style={{ paddingTop: "100px", paddingBottom: "64px" }}>
        <div className="lp-usecases" style={{ paddingTop: 24 }}>
          <div className="lp-stat-label" style={{ textAlign: "center" }}>
            Teams &amp; partners
          </div>
          <h1 className="lp-usecases-title" style={{ textAlign: "center" }}>
            One map, many jobs.
          </h1>
          <p className="lp-usecases-sub" style={{ margin: "0 auto 28px", textAlign: "center" }}>
            {siteName} is built for residents and drivers first. The same incident stream and tools also support
            logistics, newsrooms, and analysts <strong>without</strong> maintaining separate in-app
            &quot;panels&quot; per industry. This page is the hub for <strong>where to click</strong> in the
            product and <strong>how we scope</strong> pilot and Pro features.
          </p>

          <div className="lp-usecases-grid">
            <div className="lp-usecase-card">
              <div className="lp-usecase-top">
                <div className="lp-usecase-name">Logistics &amp; detours</div>
              </div>
              <p className="lp-usecase-body" style={{ margin: 0 }}>
                Open the <strong>live map</strong>, set a route in the sidebar, and compare direct vs
                &quot;safer&quot; routing with live avoid zones. Use <strong>Layers</strong> to tune heat and
                districts.
              </p>
              <p className="lp-teams-cta" style={{ margin: "12px 0 0" }}>
                <Link href="/" className="lp-hero-cta" style={{ display: "inline-block", marginTop: 0 }}>
                  Open the map
                </Link>
              </p>
            </div>

            <div className="lp-usecase-card">
              <div className="lp-usecase-top">
                <div className="lp-usecase-name">Press / keyword alerts</div>
                <span className="lp-usecase-badge">Pro</span>
              </div>
              <p className="lp-usecase-body" style={{ margin: 0 }}>
                Keyword watches and push are managed next to <strong>notification settings</strong> (alerts
                drawer). Sign in, then open the bell menu on the <strong>settings</strong> tab to add keywords.
              </p>
              <p className="lp-teams-cta" style={{ margin: "12px 0 0" }}>
                <Link href="/?inbox=settings" className="lp-hero-cta" style={{ display: "inline-block", marginTop: 0 }}>
                  Map → alert &amp; keyword settings
                </Link>
              </p>
            </div>

            <div className="lp-usecase-card">
              <div className="lp-usecase-top">
                <div className="lp-usecase-name">Venue &amp; corridor awareness</div>
              </div>
              <p className="lp-usecase-body" style={{ margin: 0 }}>
                On the same map, use <strong>heatmap</strong>, <strong>time window</strong>, and <strong>basemap
                layers</strong> to read density and trends near an address. There is no separate venue
                product, which keeps expectations aligned with what we ship today.
              </p>
              <p className="lp-teams-cta" style={{ margin: "12px 0 0" }}>
                <Link href="/" className="lp-hero-cta" style={{ display: "inline-block", marginTop: 0 }}>
                  Open the map
                </Link>
              </p>
            </div>

            <div className="lp-usecase-card">
              <div className="lp-usecase-top">
                <div className="lp-usecase-name">Research &amp; API pilot</div>
                <span className="lp-usecase-badge">Pro</span>
              </div>
              <p className="lp-usecase-body" style={{ margin: 0 }}>
                <strong>Search</strong> and <strong>pagination</strong> in the app mirror public HTTP
                endpoints. Unauthenticated and free reads are clamped to about the <strong>last hour</strong> of
                incidents. Pro can query deeper history. Treat programmatic access as a <strong>limited
                pilot</strong>. Check with us before you hard-code a production data dependency.
              </p>
              <p className="lp-teams-cta" style={{ margin: "12px 0 0", display: "flex", flexWrap: "wrap", gap: 10 }}>
                <Link href="/use-cases/api" className="lp-hero-cta" style={{ display: "inline-block", marginTop: 0 }}>
                  Developer docs
                </Link>
                <Link href="/login" className="lp-hero-cta" style={{ display: "inline-block", marginTop: 0 }}>
                  Sign in for Pro
                </Link>
              </p>
            </div>

            <div className="lp-usecase-card" style={{ gridColumn: "1 / -1" }}>
              <div className="lp-usecase-top">
                <div className="lp-usecase-name">Contact &amp; product scope</div>
              </div>
              <p className="lp-usecase-body" style={{ margin: 0 }}>
                From the map, use <strong>Send feedback</strong> in the control stack to reach the team, or
                your existing partner contact for API and pilot access. We are <strong>not</strong> building
                parallel in-app &quot;persona apps&quot; until a workflow truly needs that (for example org admin, API
                keys, or bulk export). The live map and HTTP APIs stay the shared core.
              </p>
            </div>
          </div>

          <p className="lp-usecases-note" style={{ marginTop: 28, textAlign: "center", maxWidth: 640, margin: "28px auto 0" }}>
            All data is <strong>UNVERIFIED</strong> scanner-sourced intelligence, not a dispatch or emergency
            system. See the{" "}
            <Link href="/" className="underline underline-offset-4" style={{ color: "rgb(var(--accent-rgb))" }}>
              landing page
            </Link>
            {", "}
            <Link href="/use-cases" className="underline underline-offset-4" style={{ color: "rgb(var(--accent-rgb))" }}>
              shareable use-case pages
            </Link>
            {", "}
            or <Link href="/login" className="underline underline-offset-4" style={{ color: "rgb(var(--accent-rgb))" }}>sign in</Link>.
          </p>
        </div>
      </main>

      <footer className="lp-cta" style={{ padding: "2rem 24px 3rem" }}>
        <p className="lp-footer-note" style={{ margin: 0 }}>
          © {new Date().getFullYear()} {siteName} ·{" "}
          <Link href="/" style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}>
            CityPulse
          </Link>
        </p>
      </footer>
    </div>
  );
}
