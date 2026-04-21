/**
 * Tiny "static map" planner that piggybacks on the same CARTO raster
 * tiles the main Leaflet map already uses.
 *
 * Why we do it this way:
 *   - Citizen's feed shows a per-row mini-map. Naively that means
 *     hitting a static-maps API (Stadia/MapTiler/Geoapify). Even on
 *     their generous free tiers, a busy network of users scrolling
 *     20-row pages all day would torch the quota *and* require a
 *     server-side or build-time API key.
 *   - But the user's browser is already loading these exact CARTO
 *     tiles for the main map. The service worker (`public/sw.js`)
 *     keeps the last 4000 of them in an LRU cache. So if we render
 *     a per-row thumbnail from the *same* tile URLs, we get:
 *       • zero extra HTTP cost when the tile is already cached
 *         (extremely common for the user's home city at typical
 *         zooms),
 *       • bounded extra cost otherwise (one cache miss per tile,
 *         one-time, then warm forever),
 *       • no API key, no client-side quota, free for every user
 *         regardless of tier.
 *
 * Layout strategy:
 *   We always stitch a 2×2 grid (4 tiles → 512×512 px source canvas).
 *   The "anchor" tile is chosen so the incident lat/lng falls roughly
 *   in the center of the stitched canvas, which means the marker
 *   sits in the center of any reasonably-sized thumbnail viewport
 *   (≤ 256×256). 1×1 would have been cheaper but then markers near
 *   a tile edge end up clipped against the edge of the thumbnail —
 *   ugly *and* unhelpful (loses the "what's around this incident"
 *   context).
 */

const TILE_SIZE = 256;

function lng2tileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * Math.pow(2, z);
}

function lat2tileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) *
    Math.pow(2, z)
  );
}

export interface StaticMapTile {
  url: string;
  /** Grid X (0 = left half, 1 = right half) within the 2×2 stitch. */
  gx: number;
  /** Grid Y (0 = top half, 1 = bottom half) within the 2×2 stitch. */
  gy: number;
}

export interface StaticMapPlan {
  tiles: StaticMapTile[];
  /** X position of the marker in the 512×512 stitched canvas. */
  markerX: number;
  /** Y position of the marker in the 512×512 stitched canvas. */
  markerY: number;
  /** Stitched canvas width (always 2 × TILE_SIZE). */
  canvasWidth: number;
  /** Stitched canvas height (always 2 × TILE_SIZE). */
  canvasHeight: number;
}

export type StaticMapVariant = "dark" | "light" | "voyager";

function variantPath(v: StaticMapVariant): string {
  switch (v) {
    case "dark":
      return "dark_all";
    case "light":
      return "light_all";
    case "voyager":
      return "rastertiles/voyager";
  }
}

/**
 * Pick a 2×2 tile arrangement and the marker pixel offset for the
 * given lat/lng/zoom. Pure function — no I/O, safe to call on every
 * render.
 */
export function planStaticMap(
  lat: number,
  lng: number,
  zoom = 15,
  variant: StaticMapVariant = "dark"
): StaticMapPlan {
  const tx = lng2tileX(lng, zoom);
  const ty = lat2tileY(lat, zoom);

  // Anchor tile (top-left of the 2×2). Choosing `floor(t - 0.5)`
  // biases the anchor so the marker tends to fall near the *center*
  // of the stitched 512×512 canvas rather than near an edge.
  const anchorX = Math.floor(tx - 0.5);
  const anchorY = Math.floor(ty - 0.5);

  const markerX = Math.round((tx - anchorX) * TILE_SIZE);
  const markerY = Math.round((ty - anchorY) * TILE_SIZE);

  const style = variantPath(variant);
  const tiles: StaticMapTile[] = [];

  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const X = anchorX + dx;
      const Y = anchorY + dy;
      // Rotate across CARTO's a/b/c/d subdomains both for bandwidth
      // parallelism and to mirror Leaflet's `{s}` substitution — that
      // way the SW tile cache key matches what the main map produced
      // and we maximise cache hits.
      const sub = "abcd"[(X + Y + 4) % 4];
      tiles.push({
        url: `https://${sub}.basemaps.cartocdn.com/${style}/${zoom}/${X}/${Y}.png`,
        gx: dx,
        gy: dy,
      });
    }
  }

  return {
    tiles,
    markerX,
    markerY,
    canvasWidth: TILE_SIZE * 2,
    canvasHeight: TILE_SIZE * 2,
  };
}

export const TILE_PIXEL_SIZE = TILE_SIZE;
