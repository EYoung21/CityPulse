"use client";

/**
 * ApiSection
 *
 * Persona deep-dive for the developer API pilot. Two-pane layout that
 * matches the rest:
 *   - Left: a "terminal" pane with a curl request being typed
 *     character-by-character, then the JSON response streams in below.
 *   - Right: a structured incident-card view rendered from the same
 *     response data, plus the deep-link CTA into the developer docs.
 *
 * The cycle restarts after the response finishes streaming so visitors
 * always see the request "fire" if they scroll back.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Terminal, Code2, Lock, ArrowRight } from "lucide-react";
import type { PulseCity } from "@/lib/pulse-cities";

const REQ_LINES = [
  "curl -s https://api.citypulse.live/v1/incidents \\",
  "  -H 'authorization: Bearer $PULSE_API_KEY' \\",
  "  -G \\",
  "  --data-urlencode 'city=%CITY%' \\",
  "  --data-urlencode 'since=15m' \\",
  "  --data-urlencode 'category=violent,fire'",
];

const RESPONSE = (city: string, accentRgb: string) =>
  ({
    body: [
      "{",
      `  "city": "${city}",`,
      `  "window_min": 15,`,
      `  "count": 3,`,
      `  "incidents": [`,
      `    {`,
      `      "id": "inc_018f9a2c…",`,
      `      "category": "violent",`,
      `      "transcript": "Shots fired, witnesses…",`,
      `      "location": { "lat": 39.952, "lng": -75.165 },`,
      `      "fired_at": "2026-05-10T14:32:11Z"`,
      `    },`,
      `    { "id": "inc_018f9a2d…", "category": "fire", … },`,
      `    { "id": "inc_018f9a2e…", "category": "violent", … }`,
      `  ]`,
      "}",
    ],
    accentRgb,
  });

const STAGES = {
  Typing: "typing",
  Firing: "firing",
  Responding: "responding",
  Done: "done",
} as const;
type Stage = (typeof STAGES)[keyof typeof STAGES];

const TYPE_CHARS_PER_TICK = 4;
const TYPE_TICK_MS = 24;
const FIRE_DELAY_MS = 500;
const RESPONSE_LINE_MS = 95;
const HOLD_MS = 2200;

interface Props {
  city: PulseCity;
}

export function ApiSection({ city }: Props) {
  const accentRgb = city.accentRgb ?? "171, 255, 2";
  const reqText = useMemo(
    () => REQ_LINES.join("\n").replace("%CITY%", city.slug),
    [city.slug],
  );
  const response = useMemo(
    () => RESPONSE(city.slug, accentRgb).body,
    [city.slug, accentRgb],
  );

  const prefersReducedMotion = typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [stage, setStage] = useState<Stage>(
    prefersReducedMotion ? STAGES.Done : STAGES.Typing,
  );
  const [typed, setTyped] = useState(() =>
    prefersReducedMotion ? reqText.length : 0,
  );
  const [respLine, setRespLine] = useState(() =>
    prefersReducedMotion ? response.length : 0,
  );

  /* Driver: typing → firing → responding → done → reset. */
  useEffect(() => {
    if (prefersReducedMotion) return;

    let t: number;
    if (stage === STAGES.Typing) {
      if (typed < reqText.length) {
        t = window.setTimeout(
          () => setTyped((n) => Math.min(reqText.length, n + TYPE_CHARS_PER_TICK)),
          TYPE_TICK_MS,
        );
      } else {
        t = window.setTimeout(() => setStage(STAGES.Firing), 300);
      }
    } else if (stage === STAGES.Firing) {
      t = window.setTimeout(() => {
        setStage(STAGES.Responding);
        setRespLine(0);
      }, FIRE_DELAY_MS);
    } else if (stage === STAGES.Responding) {
      if (respLine < response.length) {
        t = window.setTimeout(
          () => setRespLine((n) => n + 1),
          RESPONSE_LINE_MS,
        );
      } else {
        t = window.setTimeout(() => setStage(STAGES.Done), 200);
      }
    } else if (stage === STAGES.Done) {
      t = window.setTimeout(() => {
        setTyped(0);
        setRespLine(0);
        setStage(STAGES.Typing);
      }, HOLD_MS);
    }
    return () => window.clearTimeout(t);
  }, [stage, typed, respLine, reqText, response, prefersReducedMotion]);

  const typedText = reqText.slice(0, typed);
  const respShown = response.slice(0, respLine);

  return (
    <section
      id="api"
      className="lp-persona-section lp-api-section"
      aria-label="Developer API pilot demo"
      style={{ "--accent-rgb": accentRgb } as React.CSSProperties}
    >
      <div className="lp-route-section-inner">
        <header className="lp-route-section-head">
          <div
            className="lp-hero-channel lp-hero-channel--compact lp-route-section-eyebrow"
            role="status"
            aria-label="Developer API pilot"
          >
            <span className="lp-hero-channel__pulse" aria-hidden="true" />
            <p className="lp-hero-channel__line" style={{ margin: 0 }}>
              Developer API
              <span className="lp-route-section-pro">Pilot &middot; Pro</span>
            </p>
          </div>
          <h2 className="lp-route-section-title">
            Structured incidents, straight into your stack.
          </h2>
          <p className="lp-route-section-sub">
            Authenticated reads for the same normalized schema you see in
            the feed. Filter by city, window, and category &mdash; pull
            JSON, drop it into your pipeline. Limited pilot; talk to us
            before production loads.
          </p>
        </header>

        <div className="lp-route-section-grid lp-api-grid">
          {/* Terminal: typed request + streaming response */}
          <div className="lp-api-terminal">
            <header className="lp-api-terminal-head">
              <span className="lp-api-terminal-dot lp-api-terminal-dot--r" />
              <span className="lp-api-terminal-dot lp-api-terminal-dot--y" />
              <span className="lp-api-terminal-dot lp-api-terminal-dot--g" />
              <span className="lp-api-terminal-title">
                <Terminal className="w-3 h-3" />
                pulse-api ~ request
              </span>
            </header>
            <pre className="lp-api-terminal-body">
              <code className="lp-api-typed">
                {typedText}
                <span className="lp-api-caret">▍</span>
              </code>
            </pre>
            <div className="lp-api-statusrow">
              <span
                className={`lp-api-status ${
                  stage === STAGES.Typing
                    ? "is-pending"
                    : stage === STAGES.Firing
                      ? "is-firing"
                      : "is-ok"
                }`}
              >
                {stage === STAGES.Typing && "Composing request…"}
                {stage === STAGES.Firing && "Sending…"}
                {(stage === STAGES.Responding || stage === STAGES.Done) &&
                  "200 OK · 28ms"}
              </span>
              <span className="lp-api-statusrow-hint">
                Press ↵ <ArrowRight className="w-3 h-3" />
              </span>
            </div>
            <header className="lp-api-terminal-head lp-api-terminal-head--resp">
              <span className="lp-api-terminal-title">
                <Code2 className="w-3 h-3" />
                response.json
              </span>
            </header>
            <pre className="lp-api-terminal-body lp-api-terminal-body--resp">
              <code>
                {respShown.map((line, i) => (
                  <span key={i} className="lp-api-resp-line">
                    {line}
                    {"\n"}
                  </span>
                ))}
                {stage === STAGES.Responding && respLine < response.length && (
                  <span className="lp-api-caret">▍</span>
                )}
              </code>
            </pre>
          </div>

          {/* Right side: developer-card mockup with CTA */}
          <div className="lp-api-card-wrap">
            <div className="lp-api-card">
              <header className="lp-api-card-head">
                <span className="lp-api-card-title">incidents.list</span>
                <span className="lp-api-card-method">GET</span>
              </header>
              <dl className="lp-api-card-fields">
                <div className="lp-api-card-field">
                  <dt>city</dt>
                  <dd>
                    <code>{city.slug}</code>
                  </dd>
                </div>
                <div className="lp-api-card-field">
                  <dt>since</dt>
                  <dd>
                    <code>15m</code>
                  </dd>
                </div>
                <div className="lp-api-card-field">
                  <dt>category</dt>
                  <dd>
                    <code>violent, fire</code>
                  </dd>
                </div>
              </dl>
              <div className="lp-api-card-meta">
                <span className="lp-api-card-pro">
                  <Lock className="w-3 h-3" />
                  Bearer auth · pilot only
                </span>
              </div>
              <Link href="/use-cases/api" className="lp-api-card-cta">
                Open developer docs
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
