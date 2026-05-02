"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPublicApi, getPublicApiBase } from "@/lib/public-api-base";
import { getCurrentCity } from "@/lib/pulse-cities";

const MAX_EVENTS = 300;

export interface AdminEvent {
  type: string;
  correlation: string;
  feed_id: string;
  ts: number;
  [key: string]: unknown;
}

export interface FeedInfo {
  feed_id: string;
  label: string;
}

export interface PipelineGroup {
  correlation: string;
  feed_id: string;
  transcript?: AdminEvent;
  llm_started?: AdminEvent;
  llm_result?: AdminEvent;
  llm_error?: AdminEvent;
  inhibitor_result?: AdminEvent;
  geocode_result?: AdminEvent;
  incident_stored?: AdminEvent;
}

function wsUrl(): string {
  if (typeof window === "undefined") return "";
  const base = getPublicApiBase();
  if (base) {
    try {
      const u = new URL(base);
      const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
      return `${wsProto}//${u.host}/ws/admin`;
    } catch {
      /* fall through — same-origin */
    }
  }
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${window.location.host}/ws/admin`;
}

export function useAdminStream() {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [feeds, setFeeds] = useState<FeedInfo[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const slug = getCurrentCity().slug;
    const q = slug ? `?city=${encodeURIComponent(slug)}` : "";
    fetchPublicApi(`/api/admin/feeds${q}`)
      .then(async (r) => {
        if (!r.ok) return;
        const d = (await r.json()) as { feeds?: FeedInfo[] };
        setFeeds(d.feeds || []);
      })
      .catch(() => {});
  }, []);

  const connect = useCallback(() => {
    const url = wsUrl();
    if (!url) return;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (msg) => {
        try {
          const evt: AdminEvent = JSON.parse(msg.data);
          setEvents((prev) => {
            const next = [...prev, evt];
            return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
          });
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        reconnectRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => ws.close();
    } catch {}
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const pipelineGroups: PipelineGroup[] = [];
  const groupMap = new Map<string, PipelineGroup>();

  for (const evt of events) {
    const key = evt.correlation;
    if (!key) continue;
    let group = groupMap.get(key);
    if (!group) {
      group = { correlation: key, feed_id: evt.feed_id };
      groupMap.set(key, group);
      pipelineGroups.push(group);
    }
    switch (evt.type) {
      case "transcript_received":
        group.transcript = evt;
        break;
      case "llm_started":
        group.llm_started = evt;
        break;
      case "llm_result":
        group.llm_result = evt;
        break;
      case "llm_error":
        group.llm_error = evt;
        break;
      case "inhibitor_result":
        group.inhibitor_result = evt;
        break;
      case "geocode_result":
        group.geocode_result = evt;
        break;
      case "incident_stored":
        group.incident_stored = evt;
        break;
    }
  }

  return { events, connected, feeds, pipelineGroups };
}
