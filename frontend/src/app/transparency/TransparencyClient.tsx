"use client";

/** Public transparency page.
 *
 *  Shows aggregate moderation health for the active pulse city:
 *  how many scanner-derived incidents the AI pipeline shipped in the
 *  trailing 30-day window, how much moderator activity the audit log
 *  recorded, and how many feedback rows admins triaged.
 *
 *  Why this page exists: trust in an automated safety map hinges on
 *  visibility into *how* moderation happens. Without numbers, "we
 *  delete bad incidents" reads as a black-box claim. A static,
 *  public-facing snapshot — even one that admits some numbers are 0
 *  because the visitor isn't an admin — closes that gap with very
 *  little engineering surface.
 *
 *  Trade-offs:
 *    - Single-shot fetch on mount instead of a live snapshot. Stats
 *      change slowly (daily-scale at most) and the live listener
 *      cost wouldn't pay back.
 *    - We don't expose per-user metrics or note bodies. The page is
 *      open to every visitor, and aggregate health is enough for
 *      trust-building without leaking individual behavior.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  Radio,
  ClipboardCheck,
  ScrollText,
  RefreshCw,
} from "lucide-react";
import {
  fetchTransparencyStats,
  fmtNumber,
  type TransparencyStats,
} from "@/lib/transparency-stats";

const cityName =
  process.env.NEXT_PUBLIC_CITY_NAME?.trim() || "Philadelphia";

const WINDOW_DAYS = 30;

function fmtRelative(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

export default function TransparencyClient() {
  const [stats, setStats] = useState<TransparencyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchTransparencyStats(WINDOW_DAYS);
      setStats(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stats.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // The 30-day window is only loaded once on mount; users can
    // explicitly refresh if they want a fresher number. A
    // background re-fetch on a timer would just churn reads against
    // an essentially-static page.
  }, []);

  return (
    <main
      className="min-h-screen px-6 py-10"
      style={{ background: "var(--map-bg, #0a0a14)", color: "var(--panel-text, #e5e7eb)" }}
    >
      <div className="max-w-3xl mx-auto">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs hover:underline"
          style={{ color: "var(--panel-text-secondary)" }}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to {cityName} Pulse
        </Link>

        <header className="mt-4 mb-8">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            Pipeline transparency
          </h1>
          <p
            className="mt-2 text-sm leading-relaxed"
            style={{ color: "var(--panel-text-secondary)" }}
          >
            {cityName} Pulse is built from public-safety scanner audio
            transcribed and structured by an AI pipeline. These numbers
            cover the trailing <strong>{WINDOW_DAYS} days</strong>.
          </p>
        </header>

        {loading && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: "var(--panel-text-muted)" }}
          >
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading transparency snapshot…
          </div>
        )}

        {error && (
          <div
            className="flex items-start gap-2 p-3 rounded-lg text-sm"
            style={{ background: "rgba(239,68,68,0.10)", color: "#ef4444" }}
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Couldn&rsquo;t load transparency stats.</p>
              <p className="mt-1 text-xs opacity-80">{error}</p>
            </div>
          </div>
        )}

        {stats && (
          <>
            <section className="grid sm:grid-cols-3 gap-3">
              <StatCard
                label="Scanner incidents"
                value={stats.scannerIncidents === null ? "—" : fmtNumber(stats.scannerIncidents)}
                tone="ok"
                hint={stats.scannerIncidents === null
                  ? "The incident aggregate is temporarily unavailable."
                  : `Incidents the AI pipeline shipped in the last ${WINDOW_DAYS} d.`}
                Icon={Radio}
              />
              <StatCard
                label="Feedback triaged"
                value={stats.feedbackTriaged === null ? "—" : fmtNumber(stats.feedbackTriaged)}
                tone="neutral"
                hint="Status changes moderators applied to bug reports / feedback."
                Icon={ClipboardCheck}
                adminOnly
              />
              <StatCard
                label="Audit-log entries"
                value={stats.totalAuditEntries === null ? "—" : fmtNumber(stats.totalAuditEntries)}
                tone="neutral"
                hint="Every moderator action is appendable, never edited."
                Icon={ScrollText}
                adminOnly
              />
            </section>

            <section className="mt-10 space-y-3 text-sm leading-relaxed"
              style={{ color: "var(--panel-text-secondary)" }}>
              <h2
                className="text-sm font-semibold uppercase tracking-wider mb-1"
                style={{ color: "var(--panel-text-muted)" }}
              >
                How the pipeline works here
              </h2>
              <p>
                Public-safety radio is transcribed by a local Whisper
                instance, filtered for noise (acknowledgements, beeps,
                cascades), then passed through a structured-extraction LLM
                that pulls incident type, location, and severity. An
                ethical guardrail layer scrubs PII before anything is
                written to the public collection.
              </p>
              <p>
                Every signed-in viewer can mark an incident as{" "}
                <strong>still happening</strong> or{" "}
                <strong>cleared</strong>. The math is plain: net
                community votes drive a fade so users can spot scenes
                that have already wrapped up. Vote streams are
                anti-spam protected via per-voter document IDs (one
                vote per user per item).
              </p>
              <p>
                Moderators can update the status of feedback rows.{" "}
                <strong>Every</strong> moderator action writes an
                append-only audit row capturing the actor, target ID,
                and a snapshot of the affected content — so even after
                a row changes we can answer &ldquo;why?&rdquo; weeks
                later. Audit entries are tamper-evident: nobody (not
                even another moderator) can update or delete them from
                the app.
              </p>
            </section>

            <footer
              className="mt-10 flex items-center justify-between text-[11px]"
              style={{ color: "var(--panel-text-muted)" }}
            >
              <span>
                Snapshot taken {fmtRelative(stats.fetchedAtMs)} ·
                {" "}city: {stats.city}
              </span>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md transition-colors hover:bg-white/5 disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                Refresh
              </button>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  trail?: string;
  tone: "neutral" | "ok" | "warn";
  hint: string;
  Icon?: React.ComponentType<{ className?: string }>;
  /** Visual hint that the metric requires admin-read on
   *  `moderationAudit` — for unauthenticated visitors the count
   *  will read as 0 even if real activity happened. */
  adminOnly?: boolean;
}

function StatCard({
  label,
  value,
  trail,
  tone,
  hint,
  Icon,
  adminOnly,
}: StatCardProps) {
  const accent =
    tone === "ok" ? "#22c55e" : tone === "warn" ? "#f59e0b" : "#3b82f6";
  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: "var(--panel-input-bg, rgba(255,255,255,0.03))",
        border: "1px solid var(--panel-border, rgba(255,255,255,0.08))",
      }}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--panel-text-muted)" }}>
        {Icon ? <Icon className="w-3 h-3" /> : null}
        <span>{label}</span>
        {adminOnly && (
          <span
            className="ml-auto px-1 py-px rounded text-[9px]"
            style={{
              background: "rgba(168,85,247,0.10)",
              color: "#a855f7",
              border: "1px solid rgba(168,85,247,0.25)",
            }}
            title="This counter is populated from the moderation audit log, which only admins can read. Unauthenticated visitors will see 0 even if real activity happened."
          >
            admin
          </span>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold" style={{ color: accent }}>
          {value}
        </span>
        {trail && (
          <span className="text-xs" style={{ color: "var(--panel-text-secondary)" }}>
            {trail}
          </span>
        )}
      </div>
      <p
        className="mt-1 text-[11px] leading-snug"
        style={{ color: "var(--panel-text-muted)" }}
      >
        {hint}
      </p>
    </div>
  );
}
