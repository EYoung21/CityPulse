"use client";

/** Public transparency page.
 *
 *  Shows aggregate moderation health for the active pulse city:
 *  how many crowdsourced reports were submitted in the trailing
 *  30-day window, how many were community-verified vs. auto-hidden
 *  vs. moderator-removed, and a category breakdown.
 *
 *  Why this page exists: trust in a community-moderated safety map
 *  hinges on visibility into *how* moderation happens. Without
 *  numbers, "we delete bad reports" reads as a black-box claim. A
 *  static, public-facing snapshot — even one that admits some
 *  numbers are 0 because the visitor isn't an admin — closes that
 *  gap with very little engineering surface.
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
  ShieldCheck,
  EyeOff,
  Trash2,
  RefreshCw,
} from "lucide-react";
import {
  fetchTransparencyStats,
  fmtNumber,
  fmtPct,
  type TransparencyStats,
} from "@/lib/transparency-stats";
import { USER_REPORT_CATEGORIES } from "@/lib/user-reports";

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
    <div
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
            Community moderation transparency
          </h1>
          <p
            className="mt-2 text-sm leading-relaxed"
            style={{ color: "var(--panel-text-secondary)" }}
          >
            {cityName} Pulse is part scanner-derived data, part community
            reports. The community half only works if everyone can see how
            it&rsquo;s moderated. These numbers cover the trailing{" "}
            <strong>{WINDOW_DAYS} days</strong>.
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
                label="Reports submitted"
                value={fmtNumber(stats.reportsSubmitted)}
                tone="neutral"
                hint={`Crowdsourced pins dropped in the last ${WINDOW_DAYS} d.`}
              />
              <StatCard
                label="Community-verified"
                value={fmtNumber(stats.reportsVerified)}
                trail={fmtPct(stats.reportsVerified, stats.reportsSubmitted)}
                tone="ok"
                hint="At least one more confirm than dispute."
                Icon={ShieldCheck}
              />
              <StatCard
                label="Auto-hidden by votes"
                value={fmtNumber(stats.reportsAutoHidden)}
                trail={fmtPct(stats.reportsAutoHidden, stats.reportsSubmitted)}
                tone="warn"
                hint="Hidden after net votes fell to −3 or lower."
                Icon={EyeOff}
              />
            </section>

            <section className="mt-3 grid sm:grid-cols-3 gap-3">
              <StatCard
                label="Moderator removals"
                value={fmtNumber(stats.reportsAdminRemoved)}
                trail={fmtPct(stats.reportsAdminRemoved, stats.reportsSubmitted)}
                tone="warn"
                hint="Reports moderators removed from the audit log."
                Icon={Trash2}
                adminOnly
              />
              <StatCard
                label="Feedback triaged"
                value={fmtNumber(stats.feedbackTriaged)}
                tone="neutral"
                hint="Status changes moderators applied to bug reports / feedback."
                adminOnly
              />
              <StatCard
                label="Scanner incidents"
                value={fmtNumber(stats.scannerIncidents)}
                tone="neutral"
                hint="Authoritative incidents the AI pipeline picked up — for context."
              />
            </section>

            <section className="mt-8">
              <h2 className="text-sm font-semibold uppercase tracking-wider mb-3"
                style={{ color: "var(--panel-text-muted)" }}>
                Reports by category
              </h2>
              <div className="space-y-1.5">
                {USER_REPORT_CATEGORIES.map((c) => {
                  const count = stats.reportsByCategory[c.severity] ?? 0;
                  const pct = stats.reportsSubmitted
                    ? (count / stats.reportsSubmitted) * 100
                    : 0;
                  return (
                    <div
                      key={c.severity}
                      className="flex items-center gap-3 text-xs"
                    >
                      <span className="text-base shrink-0 w-6 text-center" aria-hidden="true">
                        {c.glyph}
                      </span>
                      <span className="w-32 shrink-0">{c.label}</span>
                      <div
                        className="flex-1 h-2 rounded-full overflow-hidden"
                        style={{ background: "var(--panel-input-bg)" }}
                      >
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, pct)}%`,
                            background: "rgba(168,85,247,0.55)",
                          }}
                        />
                      </div>
                      <span
                        className="w-16 text-right font-mono"
                        style={{ color: "var(--panel-text-secondary)" }}
                      >
                        {fmtNumber(count)} ({fmtPct(count, stats.reportsSubmitted)})
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="mt-10 space-y-3 text-sm leading-relaxed"
              style={{ color: "var(--panel-text-secondary)" }}>
              <h2
                className="text-sm font-semibold uppercase tracking-wider mb-1"
                style={{ color: "var(--panel-text-muted)" }}
              >
                How moderation works here
              </h2>
              <p>
                Community reports are <em>public-read</em>: anyone visiting the
                map sees them. Submitting a report requires a non-anonymous
                account so we always have an identity to attribute (and ban,
                if needed). One submission per minute per user, 25 m / 1 h
                per-category dedupe.
              </p>
              <p>
                Every signed-in viewer can <strong>confirm</strong> or{" "}
                <strong>dispute</strong> a report. The math is plain: net
                votes (confirms minus disputes) drive both the marker
                weighting and a hide threshold. Reports that fall to −3 net
                votes are auto-hidden from the map, but stay in the database
                so moderators can review them.
              </p>
              <p>
                Scanner incidents have a parallel system —{" "}
                <strong>&ldquo;still happening&rdquo;</strong> vs.{" "}
                <strong>&ldquo;cleared&rdquo;</strong> — that drives a
                community-resolved fade so users can spot scenes that have
                already wrapped up. Both vote streams are anti-spam protected
                via per-voter document IDs (one vote per user per item).
              </p>
              <p>
                Moderators can hard-delete reports and update the status of
                feedback rows. <strong>Every</strong> moderator action writes
                an append-only audit row capturing the actor, target ID, and a
                snapshot of the deleted content — so even after a row is gone
                we can answer &ldquo;why?&rdquo; weeks later. Audit entries
                are tamper-evident: nobody (not even another moderator) can
                update or delete them from the app.
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
    </div>
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
