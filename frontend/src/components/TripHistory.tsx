"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bike,
  Car,
  ChevronDown,
  Footprints,
  Accessibility,
  Clock,
  MapPin,
  Navigation,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  deleteTrip,
  getTripHistory,
  subscribeTripHistory,
  type TripHistoryEntry,
} from "@/lib/trip-history";
import { preferredSpeedUnit } from "@/hooks/useGpsSpeed";

const MODE_ICON: Record<string, LucideIcon> = {
  "foot-walking":   Footprints,
  "cycling-regular": Bike,
  "driving-car":    Car,
  "wheelchair":     Accessibility,
};

interface Props {
  onReplay: (entry: TripHistoryEntry) => void;
}

function fmtDistance(km: number, unit: "mph" | "kmh"): string {
  if (unit === "mph") {
    const mi = km * 0.621371;
    return `${mi.toFixed(mi < 1 ? 2 : 1)} mi`;
  }
  return `${km.toFixed(km < 1 ? 2 : 1)} km`;
}

function fmtElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Collapsible section in the SearchSidebar listing the user's recent
 *  completed trips. Tapping a row replays the trip via the same
 *  `pp:resume-trip` event the resume-pill uses, so the same downstream
 *  hydration codepath is reused. Each row exposes a delete-X. Empty
 *  state hides the whole section to keep the sidebar tidy for new
 *  users. */
export default function TripHistory({ onReplay }: Props) {
  const [entries, setEntries] = useState<TripHistoryEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const unit = preferredSpeedUnit();

  useEffect(() => {
    setEntries(getTripHistory());
    return subscribeTripHistory(setEntries);
  }, []);

  const visible = useMemo(() => (expanded ? entries : entries.slice(0, 3)), [entries, expanded]);

  if (entries.length === 0) return null;

  return (
    <div className="px-4 pb-3">
      <h3
        className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5 mb-1.5"
        style={{ color: "var(--panel-text-muted)" }}
      >
        <Clock className="w-3 h-3" /> Recent Trips ({entries.length})
      </h3>

      <div className="space-y-1.5">
        {visible.map((e) => {
          const Icon = MODE_ICON[e.mode] || Navigation;
          const elapsed = e.endedAt - e.startedAt;
          const destLabel = e.dest?.display_name?.split(",")[0] || "Trip";
          return (
            <div
              key={e.id}
              className="group flex items-start gap-2 px-3 py-2 rounded-lg transition-colors cursor-pointer"
              style={{ background: "var(--panel-input-bg)" }}
              onClick={() => onReplay(e)}
              role="button"
              tabIndex={0}
              onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") onReplay(e); }}
              onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--panel-hover)")}
              onMouseLeave={(ev) => (ev.currentTarget.style.background = "var(--panel-input-bg)")}
              title={`Replay: ${destLabel}`}
            >
              <div
                className="w-6 h-6 shrink-0 rounded-full flex items-center justify-center mt-0.5"
                style={{
                  background: e.completed ? "rgba(34,197,94,0.15)" : "rgba(59,130,246,0.15)",
                  color: e.completed ? "#22c55e" : "#3b82f6",
                }}
              >
                <Icon className="w-3 h-3" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <p
                    className="text-xs font-semibold truncate"
                    style={{ color: "var(--panel-text)" }}
                  >
                    {destLabel}
                  </p>
                  {e.rating != null && e.rating > 0 && (
                    <Star
                      className="w-3 h-3 shrink-0"
                      style={{ color: "#f59e0b", fill: "#f59e0b" }}
                      aria-label={`${e.rating} stars`}
                    />
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className="text-[10px]"
                    style={{ color: "var(--panel-text-muted)" }}
                  >
                    {fmtDistance(e.traveledKm, unit)} · {fmtElapsed(elapsed)} · {fmtDate(e.startedAt)}
                  </span>
                </div>
                {e.notes && (
                  <p
                    className="text-[10px] italic mt-0.5 truncate"
                    style={{ color: "var(--panel-text-muted)" }}
                  >
                    “{e.notes}”
                  </p>
                )}
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onReplay(e);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-blue-500/60 hover:text-blue-500"
                  aria-label={`Replay trip to ${destLabel}`}
                  title="Replay this trip"
                >
                  <Navigation className="w-3 h-3" />
                </button>
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (window.confirm(`Delete trip to ${destLabel}?`)) {
                      deleteTrip(e.id);
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-red-500/60 hover:text-red-500"
                  aria-label={`Delete trip to ${destLabel}`}
                  title="Delete from history"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {entries.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1.5 w-full flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider rounded-md transition-colors"
          style={{ color: "var(--panel-text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {expanded ? "Show less" : `Show all (${entries.length})`}
          <ChevronDown
            className="w-3 h-3 transition-transform"
            style={{ transform: expanded ? "rotate(180deg)" : "none" }}
          />
        </button>
      )}
    </div>
  );
}
