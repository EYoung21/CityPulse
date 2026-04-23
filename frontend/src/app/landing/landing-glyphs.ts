/**
 * landing-glyphs
 *
 * Tiny inline-SVG factory for the violent-crime icons shown on the
 * landing page (hero map blips + safer-route minimap blips). The paths
 * are intentionally identical to the gun/knife glyphs the in-app
 * IncidentMap renders for scanner-derived weapons calls — that way the
 * landing page reads as a continuation of the product, not a separate
 * marketing surface.
 *
 * The SVG strings are returned as raw markup so callers can drop them
 * into a `maplibregl.Marker(element)` element via `innerHTML`. Each
 * glyph is monochrome and inherits its color from the parent's CSS
 * `color` property via `currentColor`, so callers can re-tint without
 * regenerating the markup.
 */

export type LandingGlyph = "gun" | "knife";

const GLYPH_BODIES: Record<LandingGlyph, string> = {
  /* Same paths as IncidentMap.monoGlyphSvg("gun"). */
  gun: `<g transform="translate(20,20)" fill="currentColor" stroke="currentColor" stroke-width="0.7" stroke-opacity="0.4">
    <path d="M-8 2 L-8 0 L-9 -2 L-9 -5 L6 -5 L7 -3 L12 -3 L14 -5 L15 -5 L15 -2 L13 0 L12 0 L10 2 Z"/>
    <rect x="-10" y="0" width="5" height="9" rx="0.6"/>
    <rect x="7" y="-4" width="8" height="3" rx="0.5"/>
  </g>`,
  /* Same paths as IncidentMap.monoGlyphSvg("knife"). */
  knife: `<g transform="translate(20,19)" fill="currentColor" stroke="currentColor" stroke-width="0.7" stroke-opacity="0.4">
    <path d="M-1 -12 L3 -12 L4 -10 L4 4 L-1 4 Z"/>
    <rect x="-3" y="4" width="8" height="8" rx="1"/>
    <line x1="-3" y1="7" x2="5" y2="7" stroke="currentColor" stroke-opacity="0.5" stroke-width="0.5"/>
  </g>`,
};

/** Inline SVG markup for one violent-crime glyph, sized 100% of its
 *  container, inheriting `currentColor` for fill+stroke. */
export function landingGlyphSvg(kind: LandingGlyph): string {
  return `<svg viewBox="0 0 40 40" width="100%" height="100%" style="display:block" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    ${GLYPH_BODIES[kind]}
  </svg>`;
}

/**
 * Build the DOM element used as a `maplibregl.Marker(element)` target
 * for a single hero/route blip. Two visual variants:
 *
 *   - "blip"  : small red disc with a knife/gun glyph + a single ping
 *               ring. Used on both the hero map background and the
 *               safer-route demo overlay.
 *   - "endpoint": white start dot or accent end dot. Used by the
 *               safer-route demo for the from/to markers.
 */
export interface BlipElementOptions {
  kind: LandingGlyph;
  /** Visual size in CSS pixels (the inner glyph + ring scale to this). */
  size?: number;
  /** Optional CSS class added on top of `lp-route-blip`. */
  extraClassName?: string;
}

export function createBlipElement(opts: BlipElementOptions): HTMLDivElement {
  const size = opts.size ?? 22;
  const className = `lp-blip lp-blip--${opts.kind} ${opts.extraClassName ?? ""}`.trim();
  const el = document.createElement("div");
  el.className = "lp-map-marker-shell";
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  // Match the in-app IncidentMap: pure monochrome glyph with a drop
  // shadow, no surrounding disc or ping ring. The CSS handles a slow
  // breath / scale pulse so it still reads as "live".
  el.innerHTML = `<span class="${className}"><span class="lp-blip-glyph">${landingGlyphSvg(opts.kind)}</span></span>`;
  return el;
}

/**
 * Verdict badge dropped at the midpoint of each route on the safer-
 * route minimap: a small red ✕ on the fastest route and a small green
 * ✓ on the safer detour. The label drives the affordance home for
 * viewers who don't immediately decode the red/green color story.
 */
export function createRouteVerdictElement(
  variant: "bad" | "good",
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "lp-map-marker-shell";
  el.style.width = "22px";
  el.style.height = "22px";
  const path =
    variant === "bad"
      ? // Crisp X
        `<path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>`
      : // Heavy check
        `<path d="M5 12.5 L10 17.5 L19 7.5" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  el.innerHTML = `<span class="lp-route-verdict lp-route-verdict--${variant}"><svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">${path}</svg></span>`;
  return el;
}

/**
 * Cluster bubble in the same shape as the in-app marker-cluster: small
 * dark disc with a number and an outer ring colored by severity.
 */
export function createClusterElement(count: number): HTMLDivElement {
  const el = document.createElement("div");
  let size = 32;
  let cls = "lp-cluster--small";
  if (count >= 50) {
    size = 44;
    cls = "lp-cluster--large";
  } else if (count >= 10) {
    size = 38;
    cls = "lp-cluster--medium";
  }
  el.className = "lp-map-marker-shell";
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.innerHTML = `<span class="lp-cluster ${cls}"><span>${count}</span></span>`;
  return el;
}

/**
 * Endpoint dot for the safer-route demo. `variant: "start"` is a white
 * disc; `variant: "end"` is filled with the inherited `--accent` color.
 */
export function createEndpointElement(variant: "start" | "end"): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "lp-map-marker-shell";
  el.style.width = "14px";
  el.style.height = "14px";
  el.innerHTML = `<span class="lp-endpoint lp-endpoint--${variant}"></span>`;
  return el;
}
