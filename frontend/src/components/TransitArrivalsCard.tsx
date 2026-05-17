"use client";

/** Compact "next transit arrivals" card.
 *
 *  Provider-agnostic at the surface: callers pass a lat/lng, the card
 *  looks up the active city's transit agency (SEPTA in Philly, BART
 *  in SF — NYC/Chattanooga are unsupported and the card simply
 *  renders nothing), finds the nearest station within ~5 km, and
 *  fetches its next departures.
 *
 *  Adds a new agency = add a `case` in `resolveProvider` + a new
 *  client lib + a new /api route. No changes here. */

import { useEffect, useMemo, useState } from "react";
import { Train, Clock, AlertCircle, X as XIcon } from "lucide-react";
import { getCurrentCity } from "@/lib/pulse-cities";
import {
  nearestStation as nearestSeptaStation,
  fetchArrivals as fetchSeptaArrivals,
  type SeptaArrival,
} from "@/lib/septa";
import {
  nearestBartStation,
  fetchBartArrivals,
  type BartArrival,
} from "@/lib/bart";

interface Props {
  lat: number;
  lng: number;
  /** Max distance to consider a station "nearby" in km. */
  maxKm?: number;
  /** Max arrivals to render. */
  limit?: number;
  onClose?: () => void;
}

/** What the row renderer below consumes. Both providers normalize
 *  into this shape so the JSX doesn't have to branch on agency. */
interface DisplayArrival {
  /** "in 4 min", "Now", "5:42 PM", etc. */
  when: string;
  /** "Doylestown", "Daly City", … */
  destination: string;
  /** Status badge, optional. Empty string = hide. */
  status: string;
  /** Status badge color. Hex or CSS var. */
  statusColor: string;
  /** Stable React key. */
  key: string;
}

type ResolvedProvider =
  | { kind: "septa"; stationName: string; km: number }
  | { kind: "bart"; stationCode: string; stationName: string; km: number }
  | null;

function resolveProvider(lat: number, lng: number, maxKm: number): ResolvedProvider {
  const city = getCurrentCity().slug;
  if (city === "philly") {
    const s = nearestSeptaStation(lat, lng, maxKm);
    if (!s) return null;
    return { kind: "septa", stationName: s.station.name, km: s.km };
  }
  if (city === "sf") {
    const s = nearestBartStation(lat, lng, maxKm);
    if (!s) return null;
    return {
      kind: "bart",
      stationCode: s.station.code,
      stationName: s.station.name,
      km: s.km,
    };
  }
  return null;
}

function minutesUntilIso(iso: string): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - Date.now()) / 60000);
}

function formatMinutes(m: number): string {
  if (m <= 0) return "now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

function septaStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === "on time") return "#22c55e";
  if (s.includes("late") || s.includes("delay")) return "#f59e0b";
  if (s.includes("cancel")) return "#ef4444";
  return "var(--panel-text-muted, #9ca3af)";
}

function septaToDisplay(arrivals: SeptaArrival[], limit: number): DisplayArrival[] {
  return arrivals
    .map((a) => ({
      a,
      m: minutesUntilIso(a.depart_time || a.sched_time) ?? 9999,
    }))
    .filter(({ m }) => m >= -2)
    .sort((x, y) => x.m - y.m)
    .slice(0, limit)
    .map(({ a, m }) => ({
      when: formatMinutes(m),
      destination: a.destination,
      status: a.status,
      statusColor: septaStatusColor(a.status),
      key: `${a.train_id}-${a.depart_time}`,
    }));
}

function bartToDisplay(arrivals: BartArrival[], limit: number): DisplayArrival[] {
  return arrivals.slice(0, limit).map((a, i) => {
    // BART gives "Leaving" or a string-int. Translate to our format.
    let when: string;
    if (a.minutes === "Leaving" || a.minutes === "Now") {
      when = "now";
    } else {
      const n = Number.parseInt(a.minutes, 10);
      when = Number.isFinite(n) ? formatMinutes(n) : a.minutes;
    }
    return {
      when,
      destination: a.destination,
      // BART doesn't surface delay as a separate field; the color
      // alone tells the line. Showing a status badge would be noise.
      status: "",
      statusColor: a.color,
      key: `${a.destination}-${a.minutes}-${i}`,
    };
  });
}

export default function TransitArrivalsCard({
  lat,
  lng,
  maxKm = 5,
  limit = 4,
  onClose,
}: Props) {
  const provider = useMemo(
    () => resolveProvider(lat, lng, maxKm),
    [lat, lng, maxKm]
  );
  const [upcoming, setUpcoming] = useState<DisplayArrival[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!provider) return;
    const ctrl = new AbortController();
    setLoading(true);
    setErr(null);
    const run = async () => {
      try {
        if (provider.kind === "septa") {
          const d = await fetchSeptaArrivals(
            provider.stationName,
            ctrl.signal
          );
          if (ctrl.signal.aborted) return;
          setUpcoming(
            septaToDisplay([...d.northbound, ...d.southbound], limit)
          );
        } else {
          const d = await fetchBartArrivals(provider.stationCode, ctrl.signal);
          if (ctrl.signal.aborted) return;
          setUpcoming(bartToDisplay(d.arrivals, limit));
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setErr(e instanceof Error ? e.message : "fetch failed");
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    };
    void run();
    return () => ctrl.abort();
  }, [provider, limit]);

  if (!provider) return null;

  const agencyLabel = provider.kind === "septa" ? "SEPTA" : "BART";

  return (
    <div
      className="rounded-xl p-2.5 backdrop-blur-xl"
      style={{
        background: "var(--panel-bg, rgba(15, 23, 42, 0.85))",
        border: "1px solid var(--panel-border, rgba(255,255,255,0.08))",
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Train
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: "#3b82f6" }}
            aria-hidden
          />
          <span
            className="text-[10px] font-mono font-medium uppercase tracking-wider"
            style={{ color: "#3b82f6" }}
          >
            {agencyLabel}
          </span>
          <span
            className="text-[11px] font-medium truncate"
            style={{ color: "var(--panel-text)" }}
          >
            {provider.stationName}
          </span>
          <span
            className="text-[10px] font-mono shrink-0"
            style={{ color: "var(--panel-text-muted, #9ca3af)" }}
          >
            · {provider.km.toFixed(1)} km
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close transit arrivals"
            className="p-0.5 -m-0.5 rounded"
            style={{ color: "var(--panel-text-muted, #9ca3af)" }}
          >
            <XIcon className="w-3 h-3" />
          </button>
        )}
      </div>

      {loading && upcoming.length === 0 && (
        <div
          className="text-[11px] py-1"
          style={{ color: "var(--panel-text-muted, #9ca3af)" }}
        >
          Loading next departures…
        </div>
      )}

      {err && upcoming.length === 0 && (
        <div
          className="flex items-start gap-1.5 text-[10px] py-1"
          style={{ color: "#ef4444" }}
        >
          <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
          {agencyLabel} data unavailable
        </div>
      )}

      {!loading && !err && upcoming.length === 0 && (
        <div
          className="text-[11px] py-1"
          style={{ color: "var(--panel-text-muted, #9ca3af)" }}
        >
          No upcoming departures.
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="space-y-0.5">
          {upcoming.map((a) => (
            <div key={a.key} className="flex items-center gap-2 text-[11px]">
              <Clock
                className="w-3 h-3 shrink-0"
                style={{ color: "var(--panel-text-muted, #9ca3af)" }}
                aria-hidden
              />
              <span
                className="font-mono tabular-nums shrink-0"
                style={{ color: "var(--panel-text)" }}
              >
                {a.when}
              </span>
              <span
                className="truncate flex-1"
                style={{ color: "var(--panel-text-secondary, #d1d5db)" }}
              >
                {a.destination}
              </span>
              {a.status && (
                <span
                  className="font-mono text-[10px] shrink-0"
                  style={{ color: a.statusColor }}
                >
                  {a.status}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
