"use client";

import { useEffect, useRef, useState } from "react";
import { Clock, ChevronDown, Lock } from "lucide-react";
import {
  TIME_FILTERS,
  PRIMARY_TIME_FILTERS,
  SECONDARY_TIME_FILTERS,
  type TimeFilterRow,
} from "@/lib/time-filters";

interface Props {
  /** Active window in hours. Matched against TIME_FILTERS[*].hours. */
  hours: number;
  isPro: boolean;
  /** Called with the selected row. Caller is responsible for paywall
   *  routing — see the existing setShowUpgrade("Extended History")
   *  pattern in MapHome. */
  onPick: (row: TimeFilterRow) => void;
  /** Visual density. The map filter strip uses "default"; the feed
   *  view uses "compact" to fit inside its narrower header pill. */
  density?: "default" | "compact";
  /** Map filter strip uses translucent `--pill-*` chrome; the feed
   *  view sits inside a panel and uses `--panel-input-*` chrome. */
  chrome?: "pill" | "panel";
}

/**
 * The shared time-window chip row. Renders six primary chips inline
 * (1h, 6h, 24h, 1w, 1mo, All) plus a "More" dropdown for the other
 * 16 windows. Stored `timeFilterHours` values are still drawn from
 * the full TIME_FILTERS table — only the visible chip set is trimmed.
 *
 * Why six: 22 buttons in one row was the single loudest piece of
 * clutter on the map. No real user clicks 5m vs 10m vs 15m vs 30m
 * during a session; they pick a window once and live with it.
 */
export default function TimeWindowChips({
  hours,
  isPro,
  onPick,
  density = "default",
  chrome = "pill",
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeRow = TIME_FILTERS.find((t) => t.hours === hours) ?? null;
  const activeIsSecondary = activeRow ? !activeRow.primary : false;

  const chipPadding =
    density === "compact" ? "px-2.5 py-1.5 text-[11px]" : "px-3 md:px-4 py-2 md:py-2.5 text-xs md:text-sm";
  const chromeStyle =
    chrome === "panel"
      ? { background: "var(--panel-input-bg)", border: "1px solid var(--panel-border)" }
      : { background: "var(--pill-bg)", border: "1px solid var(--pill-border)" };
  const inactiveColor =
    chrome === "panel" ? "var(--panel-text-secondary)" : "var(--pill-text)";

  const renderChip = (tf: TimeFilterRow, onTap: () => void) => {
    const locked = tf.pro && !isPro;
    const active = tf.hours === hours;
    return (
      <button
        key={tf.label}
        type="button"
        onClick={onTap}
        className={`${chipPadding} font-medium transition-colors relative shrink-0 ${
          active ? "bg-blue-500/15 text-blue-500" : ""
        } ${locked ? "opacity-50" : ""}`}
        style={active ? {} : { color: locked ? "var(--panel-text-muted)" : inactiveColor }}
        title={locked ? "Pro feature · upgrade to unlock" : undefined}
      >
        {tf.label}
        {locked && <Lock className="w-3 h-3 absolute -top-0.5 -right-0.5 text-purple-400" />}
      </button>
    );
  };

  return (
    <div
      ref={ref}
      className={`flex items-center rounded-full ${chrome === "pill" ? "shadow-lg backdrop-blur-md" : ""} shrink-0 overflow-visible no-scrollbar max-md:w-full`}
      style={chromeStyle}
    >
      <Clock
        className={`${density === "compact" ? "w-3.5 h-3.5 ml-2.5" : "w-4 h-4 ml-3 md:ml-4"} shrink-0`}
        style={{ color: "var(--panel-text-muted)" }}
      />
      {PRIMARY_TIME_FILTERS.map((tf) =>
        renderChip(tf, () => {
          if (tf.pro && !isPro) {
            onPick(tf); // caller still gets the row; it can choose to paywall.
            return;
          }
          onPick(tf);
        })
      )}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`${chipPadding} font-medium transition-colors relative shrink-0 flex items-center gap-1 ${
            activeIsSecondary ? "bg-blue-500/15 text-blue-500" : ""
          }`}
          style={activeIsSecondary ? {} : { color: inactiveColor }}
          title="More time windows"
        >
          {activeIsSecondary && activeRow ? activeRow.label : "More"}
          <ChevronDown
            className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {open && (
          <div
            role="menu"
            className={`absolute z-50 right-0 mt-1.5 grid grid-cols-3 gap-1 p-1.5 rounded-xl ${chrome === "pill" ? "backdrop-blur-md shadow-2xl" : ""}`}
            style={{
              ...chromeStyle,
              minWidth: 200,
            }}
          >
            {SECONDARY_TIME_FILTERS.map((tf) =>
              renderChip(tf, () => {
                onPick(tf);
                setOpen(false);
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
