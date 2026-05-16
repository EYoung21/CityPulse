/**
 * Color utilities.
 *
 * The codebase historically appended hex bytes to incident-marker colors
 * to fake an alpha tint — e.g. `sev.markerColor + "20"`. That looks like
 * "20% opacity" but actually renders as 32/255 ≈ 12.5% (because "20" is
 * a hex byte, not a percent). Several call sites silently shipped
 * fainter active states than the author intended.
 *
 * `withAlpha` replaces the pattern with an explicit percentage and uses
 * CSS `color-mix()` so the input color can be any browser-parseable
 * format (hex, rgb, hsl, named).
 */

/** Apply a percentage alpha to a CSS color. */
export function withAlpha(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}
