"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Lock,
  MessageCircle,
  Pencil,
  Plus,
  Send,
  Square,
  ChevronDown,
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
  /** ISO lower bound for incident RAG; null = no lower bound (matches map "All"). */
  sinceIso: string | null;
  isPro: boolean;
  authLoading: boolean;
  activeTimeLabel: string;
  onClose: () => void;
  onRequestPro: () => void;
}

export default function AskPulsePanel({
  citySlug,
  sinceIso,
  isPro,
  authLoading,
  activeTimeLabel,
  onClose,
  onRequestPro,
}: AskPulsePanelProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);
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
    setThreadMenuOpen(false);
  }, []);

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
        since: sinceIso,
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
    sinceIso,
    updateThread,
  ]);

  const startEdit = useCallback((m: ChatRow) => {
    if (m.role !== "user" || loading) return;
    setEditingMessageId(m.id);
    setDraft(m.content);
    setError(null);
  }, [loading]);

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
            Context: {activeTimeLabel} · {citySlug} · UNVERIFIED scanner data
          </p>
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setThreadMenuOpen((o) => !o)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium max-w-[140px] sm:max-w-[200px]"
            style={{ background: "var(--panel-input-bg)", color: "var(--panel-text)" }}
            aria-expanded={threadMenuOpen}
            aria-haspopup="listbox"
          >
            <span className="truncate">{activeThread?.title ?? "Chat"}</span>
            <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-60" />
          </button>
          {threadMenuOpen && (
            <ul
              className="absolute right-0 top-full mt-1 z-50 min-w-[200px] max-w-[min(90vw,280px)] rounded-lg border shadow-lg py-1 max-h-64 overflow-y-auto"
              style={{
                background: "var(--panel-bg)",
                borderColor: "var(--panel-border)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
              }}
              role="listbox"
            >
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={t.id === activeId}
                    className="w-full text-left px-3 py-2 text-xs truncate hover:bg-white/5"
                    style={{ color: t.id === activeId ? "#60a5fa" : "var(--panel-text)" }}
                    onClick={() => {
                      setActiveId(t.id);
                      setThreadMenuOpen(false);
                      setEditingMessageId(null);
                      setDraft("");
                      setError(null);
                    }}
                  >
                    {t.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          onClick={newThread}
          className="p-2 rounded-lg shrink-0"
          style={{ background: "var(--panel-input-bg)", color: "var(--panel-text)" }}
          title="New chat"
          aria-label="New chat"
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-medium px-2 py-1 rounded-lg shrink-0"
          style={{ color: "var(--panel-text-muted)" }}
        >
          Close
        </button>
      </header>

      {error && (
        <div className="shrink-0 mx-3 mt-2 px-3 py-2 rounded-lg text-xs bg-red-500/15 text-red-300 border border-red-500/25">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-4 space-y-3">
        {activeThread?.messages.length === 0 && !loading && (
          <p className="text-sm text-center py-8" style={{ color: "var(--panel-text-muted)" }}>
            Ask what&apos;s happening in {citySlug}, or search themes across the loaded incident window. Answers use only
            incidents the server attached to this request.
          </p>
        )}
        {activeThread?.messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[min(92%,520px)] rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words ${
                m.role === "user" ? "rounded-br-md" : "rounded-bl-md"
              }`}
              style={
                m.role === "user"
                  ? { background: "rgba(59,130,246,0.2)", color: "var(--panel-text)" }
                  : { background: "var(--panel-input-bg)", color: "var(--panel-text-secondary)" }
              }
            >
              {m.role === "user" && (
                <div className="flex justify-end gap-1 mb-1">
                  <button
                    type="button"
                    onClick={() => startEdit(m)}
                    className="p-0.5 rounded opacity-60 hover:opacity-100"
                    aria-label="Edit message"
                    disabled={loading}
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              )}
              {m.content}
            </div>
          </div>
        ))}
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
        {editingMessageId && (
          <p className="text-[11px] mb-2" style={{ color: "#fbbf24" }}>
            Editing a previous message — send to replace it and continue from here.
          </p>
        )}
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
      </footer>
    </div>
  );
}
