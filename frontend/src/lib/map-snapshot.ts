"use client";

/** Map screenshot helpers.
 *
 *  Tactic: rasterize a chosen DOM element (typically the Leaflet map
 *  container) to a PNG via html-to-image, then offer it through the
 *  Web Share API (mobile) or fall back to a download link (desktop).
 *
 *  CORS notes:
 *    Leaflet tiles from CARTO and OSM serve `Access-Control-Allow-
 *    Origin: *`, so html-to-image can sample their pixels without
 *    issue. If a future basemap provider doesn't, the snapshot will
 *    render the overlays + Leaflet chrome but the tile area will be
 *    blank — we trap that and return a `tilesMissing: true` flag so
 *    the UI can warn the user.
 *
 *  Branding:
 *    The snapshot includes a small bottom-right watermark drawn by
 *    composing the rendered Leaflet PNG onto a slightly taller canvas
 *    with the current city brand caption. Keeps shared
 *    screenshots attributable without anyone having to add it manually.
 */

import { toPng } from "html-to-image";
import { citySiteName, getCurrentCity } from "@/lib/pulse-cities";

export interface SnapshotOptions {
  /** DOM element to rasterize. Typically the Leaflet `.leaflet-container`. */
  element: HTMLElement;
  /** Optional override caption — defaults to the current city brand. */
  caption?: string;
  /** Pixel ratio for the output canvas. Defaults to 2 for crisp
   *  retina output. Higher values blow out memory on large viewports. */
  pixelRatio?: number;
  /** When true, suppresses the bottom watermark band. */
  noWatermark?: boolean;
}

export interface SnapshotResult {
  blob: Blob;
  /** Best-guess heuristic: if the rendered tile area is mostly a single
   *  colour, tiles probably failed to render due to CORS or a broken
   *  cache. */
  tilesMissing: boolean;
}

const WATERMARK_HEIGHT = 36;

/** Quick heuristic: load the data-URL into a small offscreen canvas
 *  and sample 50 random pixels. If 95%+ are the same colour, tiles
 *  probably failed to render and the user is staring at a blank
 *  rectangle. */
async function detectMissingTiles(blob: Blob): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) { resolve(false); return; }
        ctx.drawImage(img, 0, 0, 64, 64);
        const data = ctx.getImageData(0, 0, 64, 64).data;
        const counts = new Map<string, number>();
        for (let i = 0; i < 50; i++) {
          const idx = (Math.floor(Math.random() * 64 * 64)) * 4;
          const key = `${data[idx]},${data[idx + 1]},${data[idx + 2]}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let mostCommon = 0;
        for (const v of counts.values()) if (v > mostCommon) mostCommon = v;
        resolve(mostCommon / 50 >= 0.95);
      } catch {
        resolve(false);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
    img.src = url;
  });
}

/** Compose the rendered map PNG onto a slightly taller canvas with a
 *  watermark caption. Returns a fresh Blob. */
async function addWatermark(
  inner: Blob,
  caption: string
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const url = URL.createObjectURL(inner);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height + WATERMARK_HEIGHT;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) { reject(new Error("no-canvas-ctx")); URL.revokeObjectURL(url); return; }
        ctx.drawImage(img, 0, 0);
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(0, img.height, c.width, WATERMARK_HEIGHT);
        ctx.fillStyle = "#e2e8f0";
        ctx.font = `${Math.max(11, Math.round(WATERMARK_HEIGHT * 0.42))}px system-ui, -apple-system, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.fillText(caption, 12, img.height + WATERMARK_HEIGHT / 2);
        ctx.fillStyle = "#a855f7";
        ctx.font = `bold ${Math.max(13, Math.round(WATERMARK_HEIGHT * 0.46))}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = "right";
        ctx.fillText("📍", c.width - 14, img.height + WATERMARK_HEIGHT / 2);
        c.toBlob(
          (b) => {
            URL.revokeObjectURL(url);
            if (b) resolve(b);
            else reject(new Error("blob-failed"));
          },
          "image/png"
        );
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image-load-failed")); };
    img.src = url;
  });
}

export async function captureMapSnapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  const { element, pixelRatio = 2, noWatermark } = opts;
  const caption = opts.caption ?? `${citySiteName(getCurrentCity())} · safe routes`;

  // html-to-image fetches every image referenced inside the tree
  // (tile <img> tags and CSS background-image URLs). For Leaflet's
  // tile pyramid this can be hundreds of requests; the SW cache
  // makes most of them instant on the second snapshot.
  const dataUrl = await toPng(element, {
    pixelRatio,
    cacheBust: false,
    // Skip the leaflet attribution control + zoom/rotation chrome —
    // the watermark we add on top of the canvas already credits the
    // tile providers via convention, and removing the buttons makes
    // the screenshot look like a published image rather than a UI.
    filter: (node) => {
      if (!(node instanceof HTMLElement)) return true;
      if (node.classList.contains("leaflet-control-zoom")) return false;
      if (node.classList.contains("leaflet-control-attribution")) return false;
      return true;
    },
  });

  const innerBlob = await (await fetch(dataUrl)).blob();
  const tilesMissing = await detectMissingTiles(innerBlob);
  const finalBlob = noWatermark ? innerBlob : await addWatermark(innerBlob, caption);
  return { blob: finalBlob, tilesMissing };
}

/** Try the Web Share API first (mobile native sheet); fall back to a
 *  download anchor on desktop. Returns true when the user completed
 *  *some* action — we treat dismissals as success because the user
 *  saw the snapshot regardless. */
export async function shareSnapshot(blob: Blob, suggestedName: string): Promise<boolean> {
  const brand = citySiteName(getCurrentCity());
  const file = new File([blob], suggestedName, { type: "image/png" });
  // The MDN-recommended capability check pattern: only attempt
  // navigator.share when canShare confirms file payloads work, which
  // tracks support across iOS Safari, Android Chrome, and desktop
  // Edge consistently.
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof (navigator as Navigator & { canShare?: (data: ShareData) => boolean }).canShare === "function" &&
    (navigator as Navigator & { canShare: (data: ShareData) => boolean }).canShare({ files: [file] })
  ) {
    try {
      await navigator.share({
        title: brand,
        text: `Map snapshot from ${brand}`,
        files: [file],
      });
      return true;
    } catch (e) {
      // AbortError = user cancelled the sheet. Treat as a soft-no
      // and don't fall back to download (which would feel like
      // double-asking).
      if (e instanceof Error && e.name === "AbortError") return false;
      // Fall through to download for other errors.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}
