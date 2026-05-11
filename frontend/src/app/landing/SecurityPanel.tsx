"use client";

/**
 * SecurityPanel
 *
 * Mockup of the layers/time-window panel that powers the venue / event
 * security view. The parent SecuritySection drives `step` (0..3) to
 * cycle the active time-window pill and the heatmap intensity bar.
 */

import { Layers, Eye, Clock, Map as MapIcon } from "lucide-react";

const STEPS = [
  { label: "1h", desc: "Right now" },
  { label: "6h", desc: "Evening shift" },
  { label: "24h", desc: "Past day" },
  { label: "3d", desc: "This weekend" },
];

interface Props {
  step: number;
  accentRgb: string;
}

export function SecurityPanel({ step, accentRgb }: Props) {
  const active = STEPS[Math.min(step, STEPS.length - 1)];
  const intensity = [25, 55, 85, 100][Math.min(step, 3)];

  return (
    <div
      className="lp-security-panel"
      aria-hidden="true"
      style={{ "--accent-rgb": accentRgb } as React.CSSProperties}
    >
      <header className="lp-security-panel-head">
        <Layers className="w-3.5 h-3.5" />
        <span>Layers &amp; time</span>
      </header>

      <div className="lp-security-panel-section">
        <div className="lp-security-panel-label">
          <Clock className="w-3 h-3" />
          Time window
        </div>
        <div className="lp-security-time-pills">
          {STEPS.map((s, i) => (
            <span
              key={s.label}
              className={`lp-security-time-pill ${i === step ? "is-active" : ""}`}
            >
              {s.label}
            </span>
          ))}
        </div>
        <p className="lp-security-panel-meta">{active.desc}</p>
      </div>

      <div className="lp-security-panel-section">
        <div className="lp-security-panel-label">
          <Eye className="w-3 h-3" />
          Heatmap intensity
        </div>
        <div className="lp-security-bar">
          <div
            className="lp-security-bar-fill"
            style={{ width: `${intensity}%` }}
          />
        </div>
        <div className="lp-security-panel-row">
          <span>Density</span>
          <span className="lp-security-panel-value">{intensity}%</span>
        </div>
      </div>

      <div className="lp-security-panel-section">
        <div className="lp-security-panel-label">
          <MapIcon className="w-3 h-3" />
          Layers
        </div>
        <ul className="lp-security-toggles">
          <li className="lp-security-toggle is-on">
            <span className="lp-security-toggle-text">Heatmap</span>
            <span className="lp-security-toggle-knob" />
          </li>
          <li className="lp-security-toggle is-on">
            <span className="lp-security-toggle-text">Districts</span>
            <span className="lp-security-toggle-knob" />
          </li>
          <li className="lp-security-toggle">
            <span className="lp-security-toggle-text">Saved places</span>
            <span className="lp-security-toggle-knob" />
          </li>
        </ul>
      </div>

      <footer className="lp-security-panel-foot">
        <span className="lp-security-panel-cta">Open live map</span>
      </footer>
    </div>
  );
}
