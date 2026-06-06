/**
 * Canonical map/feed time-window chips. Imported by MapHome, the count
 * API allow-list, and filter presets so stored `timeFilterHours` values
 * stay consistent everywhere.
 */

export type TimeFilterRow = {
  label: string;
  hours: number;
  pro: boolean;
};

export const TIME_FILTERS: readonly TimeFilterRow[] = [
  // Free: live windows up to 24h (so the default view is usable without Pro)
  { label: "5m", hours: 5 / 60, pro: false },
  { label: "10m", hours: 10 / 60, pro: false },
  { label: "15m", hours: 15 / 60, pro: false },
  { label: "30m", hours: 0.5, pro: false },
  { label: "45m", hours: 0.75, pro: false },
  { label: "1h", hours: 1, pro: false },
  { label: "2h", hours: 2, pro: false },
  { label: "3h", hours: 3, pro: false },
  { label: "6h", hours: 6, pro: false },
  { label: "12h", hours: 12, pro: false },
  { label: "24h", hours: 24, pro: false },
  // Pro: depth / lookback beyond a day
  { label: "2d", hours: 48, pro: true },
  { label: "3d", hours: 72, pro: true },
  { label: "5d", hours: 120, pro: true },
  { label: "1w", hours: 168, pro: true },
  { label: "2w", hours: 336, pro: true },
  { label: "1mo", hours: 720, pro: true },
  { label: "2mo", hours: 1440, pro: true },
  { label: "3mo", hours: 2160, pro: true },
  { label: "6mo", hours: 4320, pro: true },
  { label: "1y", hours: 8760, pro: true },
  // Infinity → client filter accepts all merged rows; extended paging has no lower bound.
  { label: "All", hours: Number.POSITIVE_INFINITY, pro: true },
] as const;

/** Largest lookback window available without CityPulse Pro (currently 1h).
 *  Derived from the table so it tracks any change to the free tier. */
export const LARGEST_FREE_TIME_FILTER_HOURS = Math.max(
  ...TIME_FILTERS.filter((t) => !t.pro && Number.isFinite(t.hours)).map((t) => t.hours)
);

/** Default map/feed lookback on a fresh session. Pro sessions keep this 24h
 *  view; non-Pro sessions are dropped to {@link LARGEST_FREE_TIME_FILTER_HOURS}. */
export const DEFAULT_TIME_FILTER_HOURS = 24;

/** Values accepted by GET /api/stats/count?hours= */
export const COUNT_API_ALLOWED_HOURS = new Set(
  TIME_FILTERS.filter((t) => Number.isFinite(t.hours)).map((t) => t.hours)
);

export function normalizeTimeFilterHours(h: number): number {
  if (typeof h !== "number" || Number.isNaN(h)) return 1;
  if (!Number.isFinite(h)) {
    const row = TIME_FILTERS.find((t) => !Number.isFinite(t.hours));
    return row ? row.hours : 1;
  }
  const exact = TIME_FILTERS.find((t) => t.hours === h);
  if (exact) return h;
  const near = TIME_FILTERS.find(
    (t) => Number.isFinite(t.hours) && Math.abs(t.hours - h) < 1e-4
  );
  return near ? near.hours : 1;
}

/** Paged Firestore backfill when the live listener window is narrower than the chip. */
export function timeFilterNeedsExtendedFetch(hours: number): boolean {
  if (!Number.isFinite(hours)) return true;
  return hours >= 1;
}

export function sinceIsoForTimeFilterHours(hours: number): string | null {
  if (!Number.isFinite(hours)) return null;
  return new Date(Date.now() - hours * 3600_000).toISOString();
}
