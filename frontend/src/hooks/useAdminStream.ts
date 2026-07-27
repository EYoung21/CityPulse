"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPublicApi, getPublicApiBase } from "@/lib/public-api-base";
import { getCurrentCity } from "@/lib/pulse-cities";
import { maybeIdToken } from "@/lib/api";
import { requestAdminTicket } from "@/lib/admin-tickets";
import { readBoundedJsonResponse } from "@/lib/upstream-response";

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
  supports_audio: boolean;
}

function cleanStreamText(value: unknown, maxLength = 500): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function normalizeAdminEvent(value: unknown): AdminEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const type = cleanStreamText(row.type, 100);
  if (!type) return null;
  return {
    ...row,
    type,
    correlation: cleanStreamText(row.correlation),
    feed_id: cleanStreamText(row.feed_id, 200),
    ts: typeof row.ts === "number" && Number.isFinite(row.ts) && row.ts >= 0 ? row.ts : 0,
  };
}

function normalizeFeeds(value: unknown): FeedInfo[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const feeds = (value as Record<string, unknown>).feeds;
  if (!Array.isArray(feeds)) return [];
  return feeds.slice(0, 500).flatMap((value): FeedInfo[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const feedId = cleanStreamText(row.feed_id, 200);
    const label = cleanStreamText(row.label, 200);
    return feedId && label
      ? [{ feed_id: feedId, label, supports_audio: row.supports_audio === true }]
      : [];
  });
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

function wsUrl(ticket: string): string {
  if (typeof window === "undefined") return "";
  const q = `?ticket=${encodeURIComponent(ticket)}`;
  const base = getPublicApiBase();
  if (base) {
    try {
      const u = new URL(base);
      const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
      return `${wsProto}//${u.host}/ws/admin${q}`;
    } catch {
      /* fall through — same-origin */
    }
  }
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${window.location.host}/ws/admin${q}`;
}

export function useAdminStream() {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [feeds, setFeeds] = useState<FeedInfo[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const slug = getCurrentCity().slug;
    const q = slug ? `?city=${encodeURIComponent(slug)}` : "";
    maybeIdToken()
      .then((idToken) =>
        fetchPublicApi(`/api/admin/feeds${q}`, {
          signal: controller.signal,
          headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
        })
      )
      .then(async (r) => {
        if (!r.ok) return;
        const data = await readBoundedJsonResponse(r, 512 * 1024);
        if (!controller.signal.aborted) setFeeds(normalizeFeeds(data));
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const connect = useCallback(async function connectSocket() {
    if (!activeRef.current) return;
    const ticket = await requestAdminTicket("ws");
    if (!activeRef.current) return;
    const url = ticket ? wsUrl(ticket) : "";
    if (!url) {
      setConnected(false);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(connectSocket, 3000);
      return;
    }

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (msg) => {
        try {
          if (typeof msg.data !== "string" || msg.data.length > 256 * 1024) return;
          const evt = normalizeAdminEvent(JSON.parse(msg.data) as unknown);
          if (!evt) return;
          setEvents((prev) => {
            const next = [...prev, evt];
            return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
          });
        } catch {}
      };

      ws.onclose = () => {
        if (!activeRef.current) return;
        setConnected(false);
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        reconnectRef.current = setTimeout(connectSocket, 3000);
      };

      ws.onerror = () => ws.close();
    } catch {
      if (activeRef.current) {
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        reconnectRef.current = setTimeout(connectSocket, 3000);
      }
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void connect();
    return () => {
      activeRef.current = false;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
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
