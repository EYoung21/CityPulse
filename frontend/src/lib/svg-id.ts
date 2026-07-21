/** Convert external identifiers into inert SVG fragment-id components.
 * Values interpolated into raw SVG markup must never contain quotes or markup. */
export function safeSvgIdPart(value: string | number): string {
  const normalized = String(value).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
  return normalized || "item";
}
