"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Lock,
  MessageCircle,
  Pencil,
  Plus,
  Send,
  Square,
  X,
} from "lucide-react";
import { fetchPulseChat, type PulseChatMessage } from "@/lib/api";

const STORAGE_KEY = "pulse_ask_pulse_v1";

type ChatRole = "user" | "assistant";

interface ChatRow {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
}

interface ChatThread {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatRow[];
}

interface PersistShape {
  threads: ChatThread[];
  activeId: string | null;
}

function uid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function defaultTitle(messages: ChatRow[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first?.content) return "New chat";
  const t = first.content.replace(/\s+/g, " ").trim();
  return t.length <= 48 ? t : `${t.slice(0, 45)}…`;
}

function loadPersist(): PersistShape {
  if (typeof window === "undefined") return { threads: [], activeId: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { threads: [], activeId: null };
    const j = JSON.parse(raw) as PersistShape;
    if (!j || !Array.isArray(j.threads)) return { threads: [], activeId: null };
    return {
      threads: j.threads.filter((t) => t && typeof t.id === "string" && Array.isArray(t.messages)),
      activeId: typeof j.activeId === "string" ? j.activeId : null,
    };
  } catch {
    return { threads: [], activeId: null };
  }
}

function savePersist(data: PersistShape) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* quota */
  }
}

export interface AskPulsePanelProps {
  citySlug: string;
  isPro: boolean;
  authLoading: boolean;
  onClose: () => void;
  onRequestPro: () => void;
}

export default function AskPulsePanel({
  citySlug,
  isPro,
  authLoading,
  onClose,
  onRequestPro,
}: AskPulsePanelProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadStripRef = useRef<HTMLDivElement | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const inlineEditRef = useRef<HTMLTextAreaElement | null>(null);
  const hydratedRef = useRef(false);

  useEffect(() => {
    const p = loadPersist();
    if (p.threads.length === 0) {
      const t0: ChatThread = { id: uid(), title: "New chat", updatedAt: Date.now(), messages: [] };
      setThreads([t0]);
      setActiveId(t0.id);
      hydratedRef.current = true;
      savePersist({ threads: [t0], activeId: t0.id });
      return;
    }
    setThreads(p.threads);
    const aid = p.activeId && p.threads.some((t) => t.id === p.activeId) ? p.activeId : p.threads[0].id;
    setActiveId(aid);
    hydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!hydratedRef.current || threads.length === 0) return;
    savePersist({ threads, activeId });
  }, [threads, activeId]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeId) ?? threads[0] ?? null,
    [threads, activeId]
  );

  const scrollToBottom = useCallback(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [activeThread?.messages, loading, scrollToBottom]);

  useEffect(() => {
    if (!editingMessageId) return;
    const root = listEndRef.current?.parentElement;
    const row = root?.querySelector<HTMLElement>(`[data-message-id="${editingMessageId}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    requestAnimationFrame(() => {
      const el = inlineEditRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
  }, [editingMessageId]);

  const updateThread = useCallback((id: string, fn: (t: ChatThread) => ChatThread) => {
    setThreads((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));
  }, []);

  const newThread = useCallback(() => {
    const t: ChatThread = { id: uid(), title: "New chat", updatedAt: Date.now(), messages: [] };
    setThreads((prev) => [t, ...prev]);
    setActiveId(t.id);
    setDraft("");
    setEditingMessageId(null);
    setError(null);
  }, []);

  useEffect(() => {
    if (!activeId || !threadStripRef.current) return;
    const el = threadStripRef.current.querySelector<HTMLElement>(`[data-thread-id="${activeId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeId, threads.length]);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  }, []);

  const send = useCallback(async () => {
    if (!isPro || authLoading || !activeThread) return;
    const text = draft.trim();
    if (!text || loading) return;

    let base: ChatRow[] = [...activeThread.messages];
    if (editingMessageId) {
      const idx = base.findIndex((m) => m.id === editingMessageId);
      if (idx >= 0 && base[idx].role === "user") {
        base = base.slice(0, idx);
        base.push({ id: editingMessageId, role: "user", content: text, ts: Date.now() });
      } else {
        base.push({ id: uid(), role: "user", content: text, ts: Date.now() });
      }
      setEditingMessageId(null);
    } else {
      base.push({ id: uid(), role: "user", content: text, ts: Date.now() });
    }

    const tid = activeThread.id;
    const userTail = base;
    updateThread(tid, (t) => ({
      ...t,
      messages: userTail,
      title: defaultTitle(userTail),
      updatedAt: Date.now(),
    }));
    setDraft("");
    setError(null);
    setLoading(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const apiMessages: PulseChatMessage[] = userTail.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const res = await fetchPulseChat({
        messages: apiMessages,
        city: citySlug,
        /** Omit `since` so the server uses the newest incidents for the city (capped),
         *  independent of the map/feed time pill — otherwise questions like "last 2 months?"
         *  only see e.g. 6h of data and answers feel wrong or evasive. */
        since: null,
        signal: ac.signal,
      });
      const assistant: ChatRow = {
        id: uid(),
        role: "assistant",
        content: res.reply,
        ts: Date.now(),
      };
      updateThread(tid, (t) => ({
        ...t,
        messages: [...userTail, assistant],
        updatedAt: Date.now(),
      }));
    } catch (e) {
      if (ac.signal.aborted) {
        setError(null);
      } else {
        setError(e instanceof Error ? e.message : "Request failed");
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setLoading(false);
    }
  }, [
    activeThread,
    authLoading,
    citySlug,
    draft,
    editingMessageId,
    isPro,
    loading,
    updateThread,
  ]);

  const startEdit = useCallback(
    (m: ChatRow) => {
      if (m.role !== "user") return;
      if (loading) stopGeneration();
      setEditingMessageId(m.id);
      setDraft(m.content);
      setError(null);
    },
    [loading, stopGeneration],
  );

  const cancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setDraft("");
  }, []);

  if (authLoading) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 p-8" style={{ color: "var(--panel-text-muted)" }}>
        <div className="w-8 h-8 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
        <p className="text-sm">Loading…</p>
      </div>
    );
  }

  if (!isPro) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-4 p-8 text-center max-w-md mx-auto">
        <Lock className="w-10 h-10 text-purple-400" aria-hidden />
        <h2 className="text-lg font-bold" style={{ color: "var(--panel-text)" }}>
          Ask Pulse is a Pro feature
        </h2>
        <p className="text-sm" style={{ color: "var(--panel-text-secondary)" }}>
          Chat with an AI assistant grounded in scanner-sourced incidents for your city. Upgrade to unlock.
        </p>
        <button
          type="button"
          onClick={onRequestPro}
          className="px-5 py-2.5 rounded-full text-sm font-semibold bg-gradient-to-r from-purple-600 to-blue-600 text-white"
        >
          Upgrade to Pro
        </button>
        <button type="button" onClick={onClose} className="text-sm underline" style={{ color: "var(--panel-text-muted)" }}>
          Back to map
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <header
        className="shrink-0 px-4 py-3 flex items-center gap-3 border-b"
        style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}
      >
        <MessageCircle className="w-5 h-5 text-blue-400 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-bold tracking-wide" style={{ color: "var(--panel-text)" }}>
            Ask Pulse
          </h1>
          <p className="text-[11px] truncate" style={{ color: "var(--panel-text-muted)" }}>
            Context: newest incidents for {citySlug} (not the map time filter) · UNVERIFIED scanner data
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-medium px-2 py-1 rounded-lg shrink-0"
          style={{ color: "var(--panel-text-muted)" }}
        >
          Close
        </button>
      </header>

      <div
        ref={threadStripRef}
        className="shrink-0 flex items-center gap-2 px-3 py-2 overflow-x-auto no-scrollbar border-b"
        style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}
        role="tablist"
        aria-label="Chat threads"
      >
        <button
          type="button"
          onClick={newThread}
          className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-medium border border-dashed"
          style={{
            borderColor: "var(--panel-border)",
            color: "var(--panel-text-secondary)",
            background: "transparent",
          }}
          title="New chat"
        >
          <Plus className="w-3 h-3" />
          New
        </button>
        {threads.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-thread-id={t.id}
              onClick={() => {
                setActiveId(t.id);
                setEditingMessageId(null);
                setDraft("");
                setError(null);
              }}
              className="shrink-0 max-w-[min(42vw,220px)] px-3 py-1.5 rounded-full text-[11px] font-medium truncate transition-colors"
              style={
                active
                  ? {
                      background: "rgba(59,130,246,0.18)",
                      color: "#60a5fa",
                      border: "1px solid rgba(59,130,246,0.35)",
                    }
                  : {
                      background: "var(--panel-input-bg)",
                      color: "var(--panel-text-secondary)",
                      border: "1px solid var(--panel-border)",
                    }
              }
              title={t.title}
            >
              {t.title}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="shrink-0 mx-3 mt-2 px-3 py-2 rounded-lg text-xs bg-red-500/15 text-red-300 border border-red-500/25">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-4 space-y-3">
        {activeThread?.messages.length === 0 && !loading && (
          <p className="text-sm text-center py-8" style={{ color: "var(--panel-text-muted)" }}>
            Ask what&apos;s happening in {citySlug}, or search themes across the newest incidents the server attaches to each
            request (not the map time filter). Answers use only that slice.
          </p>
        )}
        {activeThread?.messages.map((m) => {
          const isEditing = m.role === "user" && editingMessageId === m.id;
          return (
            <div
              key={m.id}
              data-message-id={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[min(92%,520px)] rounded-2xl px-3.5 py-2.5 text-sm break-words ${
                  m.role === "user" ? "rounded-br-md" : "rounded-bl-md"
                } ${isEditing ? "" : "whitespace-pre-wrap"}`}
                style={
                  m.role === "user"
                    ? { background: "rgba(59,130,246,0.2)", color: "var(--panel-text)" }
                    : { background: "var(--panel-input-bg)", color: "var(--panel-text-secondary)" }
                }
              >
                {m.role === "user" && !isEditing && (
                  <div className="flex justify-end gap-1 mb-1">
                    <button
                      type="button"
                      onClick={() => startEdit(m)}
                      className="p-0.5 rounded opacity-60 hover:opacity-100"
                      aria-label="Edit message"
                      title={loading ? "Edit and resend (stops current reply)" : "Edit message"}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  </div>
                )}
                {isEditing ? (
                  <div className="space-y-2">
                    <textarea
                      ref={inlineEditRef}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                      rows={4}
                      className="w-full resize-y min-h-[5.5rem] rounded-lg px-2.5 py-2 text-sm outline-none border"
                      style={{
                        background: "rgba(15,23,42,0.35)",
                        borderColor: "rgba(96,165,250,0.45)",
                        color: "var(--panel-text)",
                      }}
                      aria-label="Edit message"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border"
                        style={{
                          borderColor: "var(--panel-border)",
                          color: "var(--panel-text-secondary)",
                          background: "transparent",
                        }}
                      >
                        <X className="w-3 h-3" />
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void send()}
                        disabled={!draft.trim() || loading}
                        className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-[11px] font-semibold bg-blue-600 text-white disabled:opacity-40"
                      >
                        <Send className="w-3 h-3" />
                        Resend
                      </button>
                    </div>
                  </div>
                ) : (
                  m.content
                )}
              </div>
            </div>
          );
        })}
        {loading && (
          <div className="flex justify-start">
            <div
              className="rounded-2xl rounded-bl-md px-3 py-2 text-xs animate-pulse"
              style={{ background: "var(--panel-input-bg)", color: "var(--panel-text-muted)" }}
            >
              Thinking…
            </div>
          </div>
        )}
        <div ref={listEndRef} />
      </div>

      <footer className="shrink-0 p-3 border-t" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
        {editingMessageId ? (
          <p className="text-[11px] text-center py-1" style={{ color: "var(--panel-text-muted)" }}>
            Edit your message in the bubble above, then tap Resend or press Enter (Shift+Enter for a new line).
          </p>
        ) : (
          <div className="flex gap-2 items-end">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder="Ask Pulse…"
              disabled={loading}
              className="flex-1 resize-none rounded-xl px-3 py-2 text-sm outline-none border"
              style={{
                background: "var(--panel-input-bg)",
                borderColor: "var(--panel-border)",
                color: "var(--panel-text)",
              }}
              aria-label="Message"
            />
            {loading ? (
              <button
                type="button"
                onClick={stopGeneration}
                className="shrink-0 p-3 rounded-xl bg-red-500/20 text-red-300 border border-red-500/30"
                aria-label="Stop"
                title="Stop"
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim()}
                className="shrink-0 p-3 rounded-xl bg-blue-600 text-white disabled:opacity-40"
                aria-label="Send"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </footer>
    </div>
  );
}
