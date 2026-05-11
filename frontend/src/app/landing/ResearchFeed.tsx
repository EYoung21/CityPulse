"use client";

/**
 * ResearchFeed
 *
 * Visual mockup of the paginated, normalized incident stream — a tabular
 * feed with time / category / location / snippet columns. The parent
 * section drives `loadedCount` upward on a cycle, so rows fade in at the
 * top of the table one at a time.
 */

import { Lock, BookOpen, ArrowDownToLine } from "lucide-react";
import type { ResearchRow } from "./research-rows";

interface Props {
  rows: ResearchRow[];
  loadedCount: number;
  accentRgb: string;
}

const CATEGORY_HUE: Record<string, string> = {
  Violent: "239, 68, 68",
  Fire: "249, 115, 22",
  Vehicle: "234, 179, 8",
  Police: "59, 130, 246",
  Medical: "236, 72, 153",
};

export function ResearchFeed({ rows, loadedCount, accentRgb }: Props) {
  const visible = rows.slice(0, loadedCount);

  return (
    <div
      className="lp-research-feed"
      aria-hidden="true"
      style={{ "--accent-rgb": accentRgb } as React.CSSProperties}
    >
      <header className="lp-research-head">
        <BookOpen className="w-3.5 h-3.5" />
        <span className="lp-research-title">Incident stream</span>
        <span className="lp-research-count">
          {visible.length} of <span>247</span>
        </span>
      </header>

      <div className="lp-research-table">
        <div className="lp-research-row lp-research-row-head">
          <span>Time</span>
          <span>Category</span>
          <span>Location</span>
          <span>Snippet</span>
        </div>
        <ul className="lp-research-rows">
          {visible
            .slice()
            .reverse()
            .map((row, i) => {
              const hue = CATEGORY_HUE[row.category] ?? "148, 163, 184";
              return (
                <li
                  key={`${row.category}-${row.location}-${row.minsAgo}`}
                  className={`lp-research-row ${i === 0 ? "is-fresh" : ""}`}
                >
                  <span className="lp-research-cell lp-research-time">
                    {row.minsAgo}m
                  </span>
                  <span
                    className="lp-research-cell"
                    style={{ "--cat-rgb": hue } as React.CSSProperties}
                  >
                    <span className="lp-research-cat">
                      <span className="lp-research-cat-dot" />
                      {row.category}
                    </span>
                  </span>
                  <span className="lp-research-cell lp-research-loc">
                    {row.location}
                  </span>
                  <span className="lp-research-cell lp-research-snippet">
                    {row.snippet}
                  </span>
                </li>
              );
            })}
        </ul>
      </div>

      <footer className="lp-research-foot">
        <span className="lp-research-pager">
          <span className="lp-research-pager-pill is-active">1</span>
          <span className="lp-research-pager-pill">2</span>
          <span className="lp-research-pager-pill">3</span>
          <span className="lp-research-pager-pill">&hellip;</span>
        </span>
        <span className="lp-research-pro">
          <Lock className="w-3 h-3" />
          Pro &middot; extended history
        </span>
        <span className="lp-research-export">
          <ArrowDownToLine className="w-3 h-3" />
          CSV
        </span>
      </footer>
    </div>
  );
}
