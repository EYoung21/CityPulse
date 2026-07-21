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

const site = process.env.NEXT_PUBLIC_SITE_NAME || "CityPulse";

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
      "Not dispatch software. Incident data is scanner-sourced and not verified as fact.",
  },
  newsroom: {
    slug: "newsroom",
    cardTitle: "Press & newsroom (alerts + Ask Pulse)",
    pageTitle: `Keyword alerts and Ask Pulse for newsrooms (Pro) | ${site}`,
    metaDescription: `Two newsroom workflows on ${site}: keyword-based scanner alerts for breaking stories, and Ask Pulse — an LLM that answers "what happened today" questions over recent incidents. Both Pro.`,
    pro: true,
    headline: "Two ways to stay on top of the radio",
    paragraphs: [
      "**Keyword alerts.** Assigners and producers can get push-style watches when incidents match phrases you care about (structure fire, shots fired, a major crash) — within Pro access and fair-use limits. Watches sit next to notification settings in the alerts drawer; sign in, open the bell, then the **Settings** tab to add and manage keywords.",
      "**Ask Pulse.** The newer Pro tab lets you skip setup and just ask: *“what's been happening in Kensington this morning?”*, *“how many shootings overnight?”*. The LLM grounds answers in real `count_incidents` aggregates and pulls the supporting incidents on demand — useful when a watch list would be overkill but you still need a quick read of the radio.",
    ],
    ctas: [
      { label: "Open Ask Pulse", href: "/?view=ask" },
      { label: "Map → alert & keyword settings", href: "/?inbox=settings" },
      { label: "Sign in", href: "/login" },
    ],
    footnote:
      "Pro subscription required for keyword watches and Ask Pulse. Scanner-derived; verify before publishing.",
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
      "Not a replacement for official event or police coordination. Scanner-derived only.",
  },
  analytics: {
    slug: "analytics",
    cardTitle: "Analytics & Ask Pulse",
    pageTitle: `Analytics dashboards and Ask Pulse Q&A | ${site}`,
    metaDescription: `Pro tabs on ${site}: Analytics (hotspots, categories, timing, data-quality, routes) plus Ask Pulse — an LLM that answers questions over recent incidents with grounded aggregate counts.`,
    pro: true,
    headline: "Pre-built dashboards and an LLM that actually counts",
    paragraphs: [
      "The **Analytics** tab is a Pro surface with six views: an Overview snapshot, **Hotspots** by neighborhood, **Categories** trends over 30 days, **Timing** (time-of-day grid), **Data quality**, and **Routes** (your trip history). Every chart exports to SVG so it drops straight into a brief.",
      "**Ask Pulse** is the LLM tab. Ask things like *“how many gunshots in the last week”* or *“what's been happening near my office”* and the model uses three grounded tools — `count_incidents` for aggregates, `search_incidents` for keyword filtering, and `fetch_older_incidents` for paged history — so the numbers come from real Firestore counts, not pattern-matching a snippet.",
    ],
    ctas: [
      { label: "Open Analytics", href: "/?view=analytics" },
      { label: "Open Ask Pulse", href: "/?view=ask" },
      { label: "Sign in for Pro", href: "/login" },
    ],
    footnote:
      "Pro subscription required for both tabs. Ask Pulse output is grounded in scanner-derived data; double-check anything load-bearing.",
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
      "No self-serve org-grade API keys yet — tokens are scoped to signed-in users. Rate limits apply. Scanner-derived, not verified as fact.",
  },
};

export function getCampaign(slug: string): UseCaseCampaign | undefined {
  if (USE_CASE_SLUGS.includes(slug as UseCaseSlug)) {
    return USE_CASE_CAMPAIGNS[slug as UseCaseSlug];
  }
  return undefined;
}
