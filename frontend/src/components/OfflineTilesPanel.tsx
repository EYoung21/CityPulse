"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, Trash2, WifiOff, Check, AlertCircle } from "lucide-react";
import {
  precacheTiles,
  estimateTileCount,
  getTileCacheStats,
  clearTileCache,
  TILE_PRECACHE_LIMIT,
  type PrecacheBounds,
  type CacheStats,
} from "@/lib/offline-tiles";

interface Props {
  /** Returns the current map viewport bounds, or null if the map
   *  isn't ready. The host (page.tsx) owns the map ref. */
  getBounds: () => PrecacheBounds | null;
  /** The active basemap tile URL template (e.g. CARTO voyager). */
  tileTemplate: string;
}

/** Mini storage panel for offline tiles. Renders inside the layers
 *  menu — shows current cache size + a "Save this area" button that
 *  pre-caches the visible viewport at z14–z17 (city → block scale).
 *
 *  Why z14..z17:
 *    - z14: ≤6 tiles for a typical city viewport (regional context)
 *    - z15: ~25 tiles
 *    - z16: ~100 tiles
 *    - z17: ~400 tiles (street-level routing detail)
 *  Total ~530 tiles for a typical save → comfortably under the 2500
 *  hard cap. Adjacent saves overlap and the SW de-dupes by URL.
 */
export default function OfflineTilesPanel({ getBounds, tileTemplate }: Props) {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err" | null; text: string }>({
    kind: null,
    text: "",
  });

  const refreshStats = async () => {
    const s = await getTileCacheStats();
    setStats(s);
  };

  useEffect(() => {
    void refreshStats();
    // Recompute the estimate whenever the panel mounts so the user
    // sees an accurate "this download will be ~N tiles" preview.
    const b = getBounds();
    if (b) setEstimate(estimateTileCount(b, 14, 17));
  }, [getBounds]);

  const handleSave = async () => {
    const bounds = getBounds();
    if (!bounds) {
      setStatus({ kind: "err", text: "Map isn't ready." });
      return;
    }
    setBusy(true);
    setStatus({ kind: null, text: "" });
    try {
      const result = await precacheTiles(bounds, 14, 17, tileTemplate);
      const newlyCached = result.ok;
      const skipped = result.alreadyCached;
      setStatus({
        kind: result.fail > result.ok ? "err" : "ok",
        text:
          result.fail > result.ok
            ? `Downloaded ${newlyCached}, ${result.fail} failed (offline?).`
            : `Saved ${newlyCached} tile${newlyCached !== 1 ? "s" : ""}` +
              (skipped > 0 ? ` (${skipped} already cached).` : "."),
      });
      await refreshStats();
    } catch (e) {
      setStatus({
        kind: "err",
        text: e instanceof Error && e.message === "no-active-service-worker"
          ? "Service worker not active yet. Refresh the page and try again."
          : "Couldn't save offline tiles.",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      const cleared = await clearTileCache();
      setStatus({
        kind: cleared ? "ok" : "err",
        text: cleared ? "Offline tile cache cleared." : "Couldn't clear cache.",
      });
      await refreshStats();
    } finally {
      setBusy(false);
    }
  };

  const usagePct = stats && stats.max > 0
    ? Math.min(100, (stats.count / stats.max) * 100)
    : 0;

  return (
    <div className="px-1.5 pb-1.5 space-y-1.5">
      <div
        className="rounded-lg p-2 text-[11px]"
        style={{
          background: "var(--panel-input-bg)",
          border: "1px solid var(--panel-border)",
        }}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="inline-flex items-center gap-1.5" style={{ color: "var(--panel-text)" }}>
            <WifiOff className="w-3 h-3" />
            <span className="font-semibold">Offline cache</span>
          </span>
          <span className="tabular-nums" style={{ color: "var(--panel-text-muted)" }}>
            {stats ? `${stats.count} / ${stats.max} tiles` : "…"}
          </span>
        </div>
        <div
          className="h-1 rounded-full overflow-hidden"
          style={{ background: "var(--panel-border)" }}
          aria-label="Tile cache usage"
        >
          <div
            className="h-full transition-all"
            style={{
              width: `${usagePct}%`,
              background: usagePct > 80 ? "#f59e0b" : "#3b82f6",
            }}
          />
        </div>
        {estimate != null && (
          <p className="mt-1.5 text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
            Saving this view downloads ~{estimate.toLocaleString()} tile{estimate !== 1 ? "s" : ""}
            {estimate >= TILE_PRECACHE_LIMIT && " (capped)"}.
          </p>
        )}
      </div>

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-50"
          style={{
            background: "rgba(59,130,246,0.12)",
            color: "#3b82f6",
            border: "1px solid rgba(59,130,246,0.28)",
          }}
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          Save this view
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={busy || (stats?.count ?? 0) === 0}
          className="inline-flex items-center justify-center rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-50"
          style={{
            background: "var(--panel-input-bg)",
            color: "var(--panel-text-secondary)",
            border: "1px solid var(--panel-border)",
          }}
          aria-label="Clear offline tile cache"
          title="Clear offline tile cache"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {status.kind && (
        <p
          className="inline-flex items-center gap-1 text-[10px] leading-snug px-1"
          style={{ color: status.kind === "ok" ? "#22c55e" : "#ef4444" }}
        >
          {status.kind === "ok" ? (
            <Check className="w-3 h-3 shrink-0" />
          ) : (
            <AlertCircle className="w-3 h-3 shrink-0" />
          )}
          <span>{status.text}</span>
        </p>
      )}
    </div>
  );
}
