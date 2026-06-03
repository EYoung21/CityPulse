"use client";

import { useMemo } from "react";
import type { Incident } from "@/lib/api";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { IncidentCard } from "@/components/IncidentFeed";

// The backend rewrites each cited incident id into a standalone block marker so
// we can render a full incident card inline in the message flow.
const MARKER_RE = /\[\[INC:([0-9a-f]{12})\]\]/g;

type Segment = { kind: "text"; value: string } | { kind: "card"; id: string };

/** Renders an Ask Pulse assistant answer: markdown prose with full incident
 *  cards (badge, headline, location, time, Listen player) woven inline wherever
 *  the answer cites an incident. */
export function AskPulseAnswer({
  content,
  incidents,
}: {
  content: string;
  incidents?: Incident[];
}) {
  const byId = useMemo(() => {
    const m = new Map<string, Incident>();
    for (const inc of incidents ?? []) m.set(inc.id, inc);
    return m;
  }, [incidents]);

  const segments = useMemo<Segment[]>(() => {
    const result: Segment[] = [];
    let last = 0;
    for (const match of content.matchAll(MARKER_RE)) {
      const offset = match.index ?? 0;
      if (offset > last) result.push({ kind: "text", value: content.slice(last, offset) });
      result.push({ kind: "card", id: match[1] });
      last = offset + match[0].length;
    }
    if (last < content.length) result.push({ kind: "text", value: content.slice(last) });
    return result;
  }, [content]);

  // No incident data (e.g. older persisted messages): render plain markdown,
  // stripping any stray markers so raw tokens never show.
  if (byId.size === 0) {
    return <MarkdownMessage content={content.replace(MARKER_RE, "").trim()} />;
  }

  return (
    <div className="space-y-1">
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          const text = seg.value.trim();
          return text ? <MarkdownMessage key={i} content={text} /> : null;
        }
        const inc = byId.get(seg.id);
        if (!inc) return null;
        return (
          <div
            key={i}
            className="my-2 rounded-xl border overflow-hidden shadow-sm"
            style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}
          >
            <IncidentCard
              inc={inc}
              isSelected={false}
              onSelect={() => {}}
              density="compact"
              showInlineDetail={false}
              showMapThumbnail={false}
            />
          </div>
        );
      })}
    </div>
  );
}
