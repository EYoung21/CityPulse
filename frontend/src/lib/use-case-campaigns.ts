/**
 * Lightweight marketing pages for campaign URLs (`/use-cases/<slug>`).
 * Each entry deep-links into existing product routes, not duplicate UIs.
 */

export const USE_CASE_SLUGS = [
  "logistics",
  "newsroom",
  "venue",
  "analytics",
  "research",
  "api",
] as const;

export type UseCaseSlug = (typeof USE_CASE_SLUGS)[number];

export interface UseCaseCampaign {
  slug: UseCaseSlug;
  /** Short label for index cards */
  cardTitle: string;
  /** `<title>` / OG */
  pageTitle: string;
  metaDescription: string;
  pro?: boolean;
  /** Main H1 on the page */
  headline: string;
  /** 1 to 3 lead sentences with optional **bold** via RichParagraph. */
  paragraphs: string[];
  /** Primary action first */
  ctas: { label: string; href: string }[];
  /** Fine print under CTAs */
  footnote?: string;
}

const site = "CityPulse";

export const USE_CASE_CAMPAIGNS: Record<UseCaseSlug, UseCaseCampaign> = {
  logistics: {
    slug: "logistics",
    cardTitle: "Logistics & delivery detours",
    pageTitle: `Logistics and safer routing | ${site}`,
    metaDescription: `Route around active incidents with live avoid zones on ${site}. Open the map, compare direct and safer routes, and tune layers.`,
    headline: "Detours that respect what is happening on the street",
    paragraphs: [
      "Traffic apps optimize for speed. We add a **safety-aware** pass. Active high-severity incidents become **avoid zones** when you request a route, so drivers and dispatchers can pick a longer path that steers clear of reported scenes.",
      "Everything runs on the **same live map** as residents. Enter origin and destination in the sidebar, compare **direct** and **safer** options, and use **Layers** for heatmap and districts.",
    ],
    ctas: [{ label: "Open the live map", href: "/" }],
    footnote:
      "Not dispatch software. Public incident reports are unverified and locations are approximate.",
  },
  newsroom: {
    slug: "newsroom",
    cardTitle: "Press & newsroom incident desk",
    pageTitle: `Public incident desk for newsrooms | ${site}`,
    metaDescription: `Browse and search recent public incident reports on ${site}, with a paginated feed and map links for newsroom verification workflows.`,
    headline: "A searchable desk for recent public incident reports",
    paragraphs: [
      "Use the **full-screen feed** to browse recent reports, search descriptions and locations, and jump from a result to the shared map. The stream is paginated so an incident desk can work through current coverage without relying on a separate scanner interface.",
      "**Keyword push alerts and Ask Pulse are temporarily paused** while their retired backend is replaced. We keep those entry points out of the product until they have a supported ingestion and inference path again.",
    ],
    ctas: [
      { label: "Browse the incident feed", href: "/feed" },
      { label: "Open the live map", href: "/" },
    ],
    footnote:
      "Public-source data is unverified, locations are approximate, and reports should be checked against an authoritative source before publishing.",
  },
  venue: {
    slug: "venue",
    cardTitle: "Venue & corridor awareness",
    pageTitle: `Event and venue awareness | ${site}`,
    metaDescription: `Monitor incident density near a venue with heatmap, time filters, and layers on ${site}. Same map as everyone else, not a separate venue dashboard.`,
    headline: "Situational awareness without a separate “venue app”",
    paragraphs: [
      "For event security and operations, **density and recency** often matter more than a perfect pin. Use the **heatmap**, **time window** filters, and **basemap and layer** controls to read the corridor around an address or route.",
      "We intentionally **do not** promise a dedicated venue dashboard yet. The **live map** is the product, so expectations stay aligned with what we ship today.",
    ],
    ctas: [{ label: "Open the live map", href: "/" }],
    footnote:
      "Not a replacement for official event or police coordination. Public-source reports are approximate and unverified.",
  },
  analytics: {
    slug: "analytics",
    cardTitle: "Incident analytics",
    pageTitle: `Incident analytics dashboards | ${site}`,
    metaDescription: `Pro analytics on ${site}: neighborhood hotspots, category trends, timing, data-quality, and route-history views over public incident reports.`,
    pro: true,
    headline: "Pre-built dashboards over the public incident stream",
    paragraphs: [
      "The **Analytics** tab is a Pro surface with six views: an Overview snapshot, **Hotspots** by neighborhood, **Categories** trends over 30 days, **Timing** (time-of-day grid), **Data quality**, and **Routes** (your trip history). Every chart exports to SVG so it drops straight into a brief.",
      "Use the map and feed for individual reports, then switch to Analytics when the question is about **distribution, timing, or data quality**. Ask Pulse is temporarily paused while its retired backend is replaced.",
    ],
    ctas: [
      { label: "Open Analytics", href: "/?view=analytics" },
      { label: "Sign in for Pro", href: "/login" },
    ],
    footnote:
      "Pro subscription required. Public-source reports are unverified and should not be treated as certified records.",
  },
  research: {
    slug: "research",
    cardTitle: "Research & public-good",
    pageTitle: `Research and incident stream | ${site}`,
    metaDescription: `Searchable, paginated incident data on ${site}. Public API access includes the latest three days; Pro unlocks deeper history plus pre-built Analytics dashboards.`,
    headline: "Structured stream for analysis and civic tooling",
    paragraphs: [
      "Incidents include category, location text, timestamps, and (when geocoded) coordinates. That is enough for many oversight, academic, and civic use cases—treat outputs as research inputs, not certified records.",
      "Without Pro, HTTP reads are clamped to the **latest three days** of incidents. **Pro** unlocks longer history for the same endpoints **plus the Analytics tab** — pre-built neighborhood hotspots, 30-day category trends, time-of-day grids, and data-quality charts (SVG export per chart). The **full-screen feed** at `/feed` is another way to browse the stream without the main map chrome.",
    ],
    ctas: [
      { label: "Open Analytics", href: "/?view=analytics" },
      { label: "Browse the incident feed", href: "/feed" },
      { label: "Sign in for Pro & history", href: "/login" },
    ],
    footnote:
      "Use Pro-gated history in line with our terms. Not a certified public record.",
  },
  api: {
    slug: "api",
    cardTitle: "API access (pilot)",
    pageTitle: `Developer API (pilot) | ${site}`,
    metaDescription: `HTTP JSON API for CityPulse incidents: endpoints, Firebase Bearer auth, Pro history clamp, curl examples, and data-quality / legal notes. Limited pilot.`,
    pro: true,
    headline: "Developer API — endpoints, auth, and pilot terms",
    paragraphs: [
      "The same **search and pagination** the web app uses are available over HTTP. Reads are public; sending a **Firebase ID token** (`Authorization: Bearer`) from a signed-in **Pro** user unlocks deeper history via the same endpoints.",
      "We treat wide-scale integrations as a **limited pilot**, so check with us before you hard-code production dependencies. Full endpoint reference, auth header behavior, and `curl` examples are below.",
    ],
    ctas: [
      { label: "Sign in for Pro", href: "/login" },
      { label: "Open the live map", href: "/" },
      { label: "Teams hub", href: "/teams" },
    ],
    footnote:
      "No self-serve org-grade API keys yet — tokens are scoped to signed-in users. Rate limits apply. Public-source reports are not verified as fact.",
  },
};

export function getCampaign(slug: string): UseCaseCampaign | undefined {
  if (USE_CASE_SLUGS.includes(slug as UseCaseSlug)) {
    return USE_CASE_CAMPAIGNS[slug as UseCaseSlug];
  }
  return undefined;
}
