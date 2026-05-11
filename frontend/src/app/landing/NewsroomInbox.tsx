"use client";

/**
 * NewsroomInbox
 *
 * Visual mockup of the AlertsInbox + KeywordWatchSettings surface used by
 * Pro newsroom accounts. Not interactive — the parent section drives the
 * `firingIndex` so the matching keyword row flashes and a fresh alert
 * slides in at the top, in sync with the canvas pulse on the map.
 */

import { Bell, Radio, BellRing } from "lucide-react";
import type { NewsroomEvent } from "./newsroom-events";

interface Props {
  events: NewsroomEvent[];
  /** Index into `events` of the currently firing event. */
  firingIndex: number;
  /** Index of the watch row that should pulse. */
  matchedKeywordIndex: number;
  accentRgb: string;
}

export function NewsroomInbox({
  events,
  firingIndex,
  matchedKeywordIndex,
  accentRgb,
}: Props) {
  const recent = events.slice(0, firingIndex + 1).reverse().slice(0, 4);
  const watches = Array.from(new Set(events.map((e) => e.keyword))).slice(0, 4);

  return (
    <div
      className="lp-newsroom-inbox"
      aria-hidden="true"
      style={{ "--accent-rgb": accentRgb } as React.CSSProperties}
    >
      <header className="lp-newsroom-inbox-head">
        <div className="lp-newsroom-inbox-tab">
          <Bell className="w-3.5 h-3.5" />
          <span>Alerts</span>
        </div>
        <div className="lp-newsroom-inbox-tab is-active">
          <Radio className="w-3.5 h-3.5" />
          <span>Keywords</span>
        </div>
        <span className="lp-newsroom-inbox-pro">Pro</span>
      </header>

      <div className="lp-newsroom-inbox-section">
        <div className="lp-newsroom-inbox-label">Watching</div>
        <ul className="lp-newsroom-watches">
          {watches.map((kw, i) => (
            <li
              key={kw}
              className={`lp-newsroom-watch ${
                i === matchedKeywordIndex ? "is-firing" : ""
              }`}
            >
              <span className="lp-newsroom-watch-dot" />
              <span className="lp-newsroom-watch-text">&ldquo;{kw}&rdquo;</span>
              <span className="lp-newsroom-watch-toggle" />
            </li>
          ))}
        </ul>
      </div>

      <div className="lp-newsroom-inbox-section">
        <div className="lp-newsroom-inbox-label">Recent matches</div>
        <ul className="lp-newsroom-alerts">
          {recent.map((evt, i) => (
            <li
              key={`${evt.transcript}-${firingIndex}-${i}`}
              className={`lp-newsroom-alert ${i === 0 ? "is-fresh" : ""}`}
            >
              <span className="lp-newsroom-alert-icon">
                <BellRing className="w-3 h-3" />
              </span>
              <div className="lp-newsroom-alert-body">
                <div className="lp-newsroom-alert-top">
                  <span className="lp-newsroom-alert-kw">
                    &ldquo;{evt.keyword}&rdquo;
                  </span>
                  <span className="lp-newsroom-alert-time">
                    {i === 0 ? "just now" : `${i}m ago`}
                  </span>
                </div>
                <p className="lp-newsroom-alert-snippet">{evt.transcript}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <footer className="lp-newsroom-inbox-foot">
        <span className="lp-newsroom-inbox-cta">Manage watches</span>
      </footer>
    </div>
  );
}
