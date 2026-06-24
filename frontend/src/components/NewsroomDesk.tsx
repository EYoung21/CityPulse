"use client";

import { useCallback, useMemo, useState } from "react";
import { Download, Radio, Info } from "lucide-react";
import type { Incident } from "@/lib/api";
import { IncidentCard } from "@/components/IncidentFeed";
import {
  NEWS_DESKS,
  type NewsDesk,
  type NewsTier,
  rankForDesk,
  deskCounts,
} from "@/lib/newsworthiness";

const TIER_STYLE: Record<Exclude<NewsTier, "routine">, { label: string; bg: string; fg: string }> = {
  breaking: { label: "BREAKING", bg: "rgba(239,68,68,0.15)", fg: "#ef4444" },
  notable: { label: "NOTABLE", bg: "rgba(245,158,11,0.15)", fg: "#f59e0b" },
};

/**
 * The Newsroom desk: an assignment-desk view over live scanner activity. Scores
 * every loaded incident for newsworthiness, hides the routine long tail, and
 * ranks what's left so an editor sees what's worth a reporter right now — with
 * the signals that surfaced it and the transcript/audio to verify before
 * dispatching. See {@link rankForDesk} for the model.
 */
export default function NewsroomDesk({
  incidents,
  onViewOnMap,
  userLoc,
  loading,
}: {
  incidents: Incident[];
  onViewOnMap?: (id: string) => void;
  userLoc?: { lat: number; lng: number } | null;
  loading?: boolean;
}) {
  const [desk, setDesk] = useState<NewsDesk>("top");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [includeRoutine, setIncludeRoutine] = useState(false);

  const counts = useMemo(() => deskCounts(incidents), [incidents]);
  const ranked = useMemo(
    () => rankForDesk(incidents, desk, { includeRoutine }),
    [incidents, desk, includeRoutine],
  );

  const onSelect = useCallback(
    (id: string) => setSelectedId((prev) => (prev === id ? null : id)),
    [],
  );

  const downloadCsv = useCallback(() => {
    if (ranked.length === 0) return;
    const esc = (s: string) => (/[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const headers = [
      "rank",
      "score",
      "tier",
      "desks",
      "signals",
      "reported_at",
      "category",
      "location",
      "lat",
      "lng",
      "transcript",
    ];
    const rows = ranked.map(({ incident: inc, news }, i) => [
      String(i + 1),
      String(news.score),
      news.tier,
      esc(news.desks.join("|")),
      esc(news.signals.join("; ")),
      inc.reported_at,
      inc.severity_category,
      esc(inc.location_text || ""),
      String(inc.lat ?? ""),
      String(inc.lng ?? ""),
      esc((inc.description || inc.raw_text || "").slice(0, 400)),
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `newsroom-${desk}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [ranked, desk]);

  return (
    <div className="flex flex-col min-h-0">
      {/* Desk chips */}
      <div
        className="px-4 py-2 flex items-center gap-1.5 overflow-x-auto no-scrollbar"
        style={{ borderBottom: "1px solid var(--panel-border, rgba(148,163,184,0.15))" }}
      >
        <Radio className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
        {NEWS_DESKS.map((d) => {
          const active = desk === d.id;
          const n = counts[d.id];
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => setDesk(d.id)}
              title={d.blurb}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium shrink-0 inline-flex items-center gap-1 ${
                active ? "bg-blue-500/15 text-blue-500" : ""
              }`}
              style={active ? undefined : { color: "var(--panel-text-secondary)" }}
            >
              {d.label}
              <span className={`text-[10px] ${active ? "opacity-80" : "opacity-50"}`}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* Toolbar */}
      <div
        className="px-4 py-1.5 flex items-center gap-3 text-[11px]"
        style={{ borderBottom: "1px solid var(--panel-border, rgba(148,163,184,0.15))", color: "var(--panel-text-muted)" }}
      >
        <span className="inline-flex items-center gap-1">
          <Info className="w-3 h-3" /> Ranked by newsworthiness
        </span>
        <label className="inline-flex items-center gap-1 cursor-pointer ml-auto">
          <input
            type="checkbox"
            checked={includeRoutine}
            onChange={(e) => setIncludeRoutine(e.target.checked)}
            className="accent-blue-500"
          />
          Include routine
        </label>
        {ranked.length > 0 && (
          <button
            type="button"
            onClick={downloadCsv}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-medium hover:bg-white/5"
            style={{ color: "var(--panel-text-muted)", border: "1px solid var(--panel-border)" }}
            title={`Export ${ranked.length} ranked incidents as CSV`}
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
        )}
      </div>

      {/* Ranked list */}
      <div className="flex-1 min-h-0">
        {!loading && ranked.length === 0 && (
          <div className="px-4 py-12 text-center text-sm" style={{ color: "var(--panel-text-muted)" }}>
            Nothing newsworthy in this window yet.
            <div className="text-[11px] mt-1">Routine calls are hidden — toggle “Include routine” to see everything.</div>
          </div>
        )}
        {ranked.map(({ incident: inc, news }, i) => {
          const tierStyle = news.tier !== "routine" ? TIER_STYLE[news.tier] : null;
          return (
            <div key={inc.id} className="border-b" style={{ borderColor: "var(--panel-border, rgba(148,163,184,0.1))" }}>
              <div className="px-4 pt-2 flex items-center flex-wrap gap-1.5">
                <span className="text-[11px] font-mono tabular-nums w-6 shrink-0" style={{ color: "var(--panel-text-muted)" }}>
                  {i + 1}.
                </span>
                {tierStyle && (
                  <span
                    className="text-[9px] font-bold tracking-wide px-1.5 py-0.5 rounded"
                    style={{ background: tierStyle.bg, color: tierStyle.fg }}
                  >
                    {tierStyle.label}
                  </span>
                )}
                {news.signals.map((s) => (
                  <span
                    key={s}
                    className="text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{ background: "rgba(148,163,184,0.12)", color: "var(--panel-text-secondary)" }}
                  >
                    {s}
                  </span>
                ))}
              </div>
              <IncidentCard
                inc={inc}
                isSelected={selectedId === inc.id}
                onSelect={() => onSelect(inc.id)}
                onViewOnMap={onViewOnMap}
                showMapThumbnail
                density="immersive"
                userLoc={userLoc}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
