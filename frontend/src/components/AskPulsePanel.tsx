"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  Clock,
  Lock,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { fetchPulseChat, type PulseChatMessage, type Incident } from "@/lib/api";
import { AskPulseAnswer } from "@/components/AskPulseAnswer";
import { normalizeIncidentList } from "@/lib/firestore-values";

const STORAGE_KEY = "pulse_ask_pulse_v1";

type ChatRole = "user" | "assistant";

interface ChatRow {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
  /** Incidents the assistant cited, rendered as inline cards. */
  cited?: Incident[];
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
  /** Ids of the chats currently shown as open tabs (a subset of `threads`,
   *  which is the full history). */
  openTabIds: string[];
}

function shortWhen(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

export function buildPulseChatMessages(
  messages: ReadonlyArray<Pick<ChatRow, "role" | "content">>,
): PulseChatMessage[] {
  return messages.slice(-40).map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export function loadAskPulsePersist(): PersistShape {
  const empty: PersistShape = { threads: [], activeId: null, openTabIds: [] };
  if (typeof window === "undefined") return empty;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return empty;
    const shape = j as Record<string, unknown>;
    if (!Array.isArray(shape.threads)) return empty;
    const threads = shape.threads.slice(0, 100).flatMap((value): ChatThread[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const thread = value as Record<string, unknown>;
      if (
        typeof thread.id !== "string" ||
        !thread.id ||
        typeof thread.title !== "string" ||
        typeof thread.updatedAt !== "number" ||
        !Number.isFinite(thread.updatedAt) ||
        !Array.isArray(thread.messages)
      ) return [];
      const messages = thread.messages.slice(0, 500).flatMap((item): ChatRow[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const message = item as Record<string, unknown>;
        if (
          typeof message.id !== "string" ||
          !message.id ||
          (message.role !== "user" && message.role !== "assistant") ||
          typeof message.content !== "string" ||
          typeof message.ts !== "number" ||
          !Number.isFinite(message.ts)
        ) return [];
        return [{
          id: message.id.slice(0, 500),
          role: message.role,
          content: message.content.slice(0, 100_000),
          ts: message.ts,
          cited: normalizeIncidentList(message.cited, 100),
        }];
      });
      return [{
        id: thread.id.slice(0, 500),
        title: thread.title.slice(0, 500),
        updatedAt: thread.updatedAt,
        messages,
      }];
    });
    const ids = new Set(threads.map((t) => t.id));
    let openTabIds = Array.isArray(shape.openTabIds)
      ? [...new Set(shape.openTabIds.filter((id): id is string => typeof id === "string" && ids.has(id)))].slice(0, 20)
      : [];
    // Migration / fallback: if no open-tab list yet, open every existing chat
    // (preserves the prior "all threads are tabs" behavior).
    if (openTabIds.length === 0) openTabIds = threads.map((t) => t.id);
    return {
      threads,
      activeId: typeof shape.activeId === "string" && ids.has(shape.activeId) ? shape.activeId : null,
      openTabIds,
    };
  } catch {
    return empty;
  }
}

function savePersist(data: PersistShape) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      threads: data.threads.slice(0, 100).map((thread) => ({
        ...thread,
        title: thread.title.slice(0, 500),
        messages: thread.messages.slice(-500).map((message) => ({
          ...message,
          content: message.content.slice(0, 100_000),
          cited: message.cited?.slice(0, 100),
        })),
      })),
      activeId: data.activeId,
      openTabIds: data.openTabIds.slice(0, 20),
    }));
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
  onViewOnMap?: (inc: Incident) => void;
}

export default function AskPulsePanel({
  citySlug,
  isPro,
  authLoading,
  onClose,
  onRequestPro,
  onViewOnMap,
}: AskPulsePanelProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Open tabs (subset of threads). `threads` is the full history.
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [draft, setDraft] = useState("");
  // Per-thread generation state so chats can generate in parallel.
  const [loadingThreads, setLoadingThreads] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const abortRefs = useRef<Map<string, AbortController>>(new Map());
  const threadStripRef = useRef<HTMLDivElement | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const inlineEditRef = useRef<HTMLTextAreaElement | null>(null);
  const hydratedRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);

  // Whether the *currently viewed* thread is generating — drives the local UI
  // (Thinking indicator, input disabled, stop button). Other threads keep
  // generating in the background regardless of this.
  const loading = activeId !== null && loadingThreads.has(activeId);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    const p = loadAskPulsePersist();
    if (p.threads.length === 0) {
      const t0: ChatThread = { id: uid(), title: "New chat", updatedAt: Date.now(), messages: [] };
      setThreads([t0]);
      setActiveId(t0.id);
      setOpenTabIds([t0.id]);
      hydratedRef.current = true;
      savePersist({ threads: [t0], activeId: t0.id, openTabIds: [t0.id] });
      return;
    }
    setThreads(p.threads);
    let open = p.openTabIds.length ? p.openTabIds : p.threads.map((t) => t.id);
    const aid = p.activeId && open.includes(p.activeId) ? p.activeId : open[0] ?? p.threads[0].id;
    if (!open.includes(aid)) open = [aid, ...open];
    setOpenTabIds(open);
    setActiveId(aid);
    hydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!hydratedRef.current || threads.length === 0) return;
    savePersist({ threads, activeId, openTabIds });
  }, [threads, activeId, openTabIds]);

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

  // A chat is "disposable" when it has no sent messages and isn't generating —
  // an abandoned blank chat we drop entirely (from tabs AND history) when the
  // user navigates away, instead of letting blanks pile up. Anything typed or
  // sent keeps it alive. Never drops the last remaining open tab.
  const pruneActiveIfDisposable = useCallback(() => {
    const cur = activeId;
    if (!cur || draft.trim() !== "" || loadingThreads.has(cur)) return;
    if (openTabIds.length <= 1) return;
    const t = threads.find((x) => x.id === cur);
    if (!t || t.messages.length > 0) return;
    setThreads((prev) => prev.filter((x) => x.id !== cur));
    setOpenTabIds((prev) => prev.filter((x) => x !== cur));
  }, [activeId, draft, loadingThreads, openTabIds, threads]);

  const switchTab = useCallback(
    (id: string) => {
      if (id === activeId) return;
      pruneActiveIfDisposable();
      setActiveId(id);
      setEditingMessageId(null);
      setDraft("");
      setError(null);
    },
    [activeId, pruneActiveIfDisposable],
  );

  const newThread = useCallback(() => {
    const t: ChatThread = { id: uid(), title: "New chat", updatedAt: Date.now(), messages: [] };
    const cur = activeId;
    const curThread = cur ? threads.find((x) => x.id === cur) : undefined;
    const dropCur =
      !!cur && draft.trim() === "" && !loadingThreads.has(cur) && !!curThread && curThread.messages.length === 0;
    setThreads((prev) => [t, ...(dropCur ? prev.filter((x) => x.id !== cur) : prev)]);
    setOpenTabIds((prev) => [t.id, ...(dropCur ? prev.filter((x) => x !== cur) : prev)]);
    setActiveId(t.id);
    setDraft("");
    setEditingMessageId(null);
    setError(null);
    setHistoryOpen(false);
  }, [activeId, draft, loadingThreads, threads]);

  // Open a chat from history (reopen a closed one or jump to an open one).
  const openTab = useCallback(
    (id: string) => {
      setHistoryOpen(false);
      if (id === activeId) return;
      pruneActiveIfDisposable();
      setOpenTabIds((prev) => (prev.includes(id) ? prev : [id, ...prev]));
      setActiveId(id);
      setEditingMessageId(null);
      setDraft("");
      setError(null);
    },
    [activeId, pruneActiveIfDisposable],
  );

  // Close a tab. Keeps the chat in history (reopen from the history list) unless
  // it's an abandoned blank, which is dropped. A still-generating chat keeps
  // generating in the background; its reply lands in history. Opens a fresh chat
  // if the last tab is closed.
  const closeTab = useCallback(
    (id: string) => {
      const t = threads.find((x) => x.id === id);
      const disposable = !!t && t.messages.length === 0 && !loadingThreads.has(id);
      const remaining = openTabIds.filter((x) => x !== id);
      if (disposable) setThreads((prev) => prev.filter((x) => x.id !== id));
      if (remaining.length === 0) {
        const nt: ChatThread = { id: uid(), title: "New chat", updatedAt: Date.now(), messages: [] };
        setThreads((prev) => [nt, ...(disposable ? prev.filter((x) => x.id !== id) : prev)]);
        setOpenTabIds([nt.id]);
        setActiveId(nt.id);
        setDraft("");
        setEditingMessageId(null);
        setError(null);
        return;
      }
      setOpenTabIds(remaining);
      if (id === activeId) {
        const idx = openTabIds.indexOf(id);
        setActiveId(remaining[Math.min(idx, remaining.length - 1)]);
        setEditingMessageId(null);
        setDraft("");
        setError(null);
      }
    },
    [threads, loadingThreads, openTabIds, activeId],
  );

  // Permanently delete a chat from history (and close its tab).
  const deleteThread = useCallback(
    (id: string) => {
      abortRefs.current.get(id)?.abort();
      abortRefs.current.delete(id);
      setLoadingThreads((prev) => {
        if (!prev.has(id)) return prev;
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
      const restThreads = threads.filter((x) => x.id !== id);
      const restOpen = openTabIds.filter((x) => x !== id);
      if (restThreads.length === 0) {
        const nt: ChatThread = { id: uid(), title: "New chat", updatedAt: Date.now(), messages: [] };
        setThreads([nt]);
        setOpenTabIds([nt.id]);
        setActiveId(nt.id);
        return;
      }
      setThreads(restThreads);
      setOpenTabIds(restOpen.length ? restOpen : [restThreads[0].id]);
      if (id === activeId || restOpen.length === 0) {
        setActiveId(restOpen[0] ?? restThreads[0].id);
        setEditingMessageId(null);
        setDraft("");
        setError(null);
      }
    },
    [threads, openTabIds, activeId],
  );

  const historyList = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    const matches = q
      ? threads.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.messages.some((m) => m.content.toLowerCase().includes(q)),
        )
      : threads;
    return [...matches].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [threads, historyQuery]);

  const handleClose = useCallback(() => {
    setHistoryOpen(false);
    // Prune an abandoned blank active chat and persist before the panel hides
    // (the save effect won't run after onClose).
    const cur = activeId;
    if (cur && draft.trim() === "" && !loadingThreads.has(cur) && openTabIds.length > 1) {
      const t = threads.find((x) => x.id === cur);
      if (t && t.messages.length === 0) {
        const nextThreads = threads.filter((x) => x.id !== cur);
        const nextOpen = openTabIds.filter((x) => x !== cur);
        const nextActive = nextOpen[0] ?? nextThreads[0]?.id ?? null;
        setThreads(nextThreads);
        setOpenTabIds(nextOpen);
        setActiveId(nextActive);
        savePersist({ threads: nextThreads, activeId: nextActive, openTabIds: nextOpen });
      }
    }
    onClose();
  }, [activeId, draft, loadingThreads, openTabIds, threads, onClose]);

  useEffect(() => {
    if (!activeId || !threadStripRef.current) return;
    const el = threadStripRef.current.querySelector<HTMLElement>(`[data-thread-id="${activeId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeId, threads.length]);

  const stopGeneration = useCallback(() => {
    const id = activeId;
    if (!id) return;
    abortRefs.current.get(id)?.abort();
    abortRefs.current.delete(id);
    setLoadingThreads((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  }, [activeId]);

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
    setLoadingThreads((prev) => new Set(prev).add(tid));

    const ac = new AbortController();
    abortRefs.current.set(tid, ac);

    const apiMessages = buildPulseChatMessages(userTail);

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
        cited: res.cited_incidents,
      };
      updateThread(tid, (t) => ({
        ...t,
        messages: [...userTail, assistant],
        updatedAt: Date.now(),
      }));
    } catch (e) {
      // Only surface the error if the user is still viewing the thread that
      // failed — a background thread's error shouldn't flash on another chat.
      if (!ac.signal.aborted && activeIdRef.current === tid) {
        setError(e instanceof Error ? e.message : "Request failed");
      }
    } finally {
      if (abortRefs.current.get(tid) === ac) abortRefs.current.delete(tid);
      setLoadingThreads((prev) => {
        const n = new Set(prev);
        n.delete(tid);
        return n;
      });
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
          Chat with an AI assistant grounded in public incident reports for your city. Upgrade to unlock.
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
    <div className="relative flex flex-col h-full min-h-0">
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
            Context: newest incidents for {citySlug} (LLM sees a capped sample — not full history or official stats)
            · UNVERIFIED public-source data
          </p>
        </div>
        <button
          type="button"
          onClick={handleClose}
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
        role="group"
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
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full border"
          style={{
            borderColor: "var(--panel-border)",
            color: "var(--panel-text-secondary)",
            background: "transparent",
          }}
          title="Chat history"
          aria-label="Chat history"
        >
          <Clock className="w-3.5 h-3.5" />
        </button>
        {openTabIds.map((id) => {
          const t = threads.find((x) => x.id === id);
          if (!t) return null;
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              data-thread-id={t.id}
              className="group shrink-0 inline-flex items-center gap-1 max-w-[min(42vw,220px)] pl-3 pr-1.5 py-1.5 rounded-full text-[11px] font-medium transition-colors"
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
            >
              <button
                type="button"
                onClick={() => switchTab(t.id)}
                aria-pressed={active}
                className="inline-flex items-center gap-1 min-w-0 truncate"
                title={t.title}
              >
                {loadingThreads.has(t.id) && (
                  <span
                    className="shrink-0 w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"
                    aria-label="Generating"
                  />
                )}
                <span className="truncate">{t.title}</span>
              </button>
              <button
                type="button"
                onClick={() => closeTab(t.id)}
                className="shrink-0 rounded-full p-0.5 opacity-50 hover:opacity-100 hover:bg-black/10 transition-opacity"
                aria-label="Close chat"
                title="Close tab"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
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
                } ${!isEditing && m.role === "user" ? "whitespace-pre-wrap" : ""}`}
                style={
                  m.role === "user"
                    ? { background: "rgba(59,130,246,0.2)", color: "var(--panel-text)" }
                    : { background: "var(--panel-input-bg)", color: "var(--panel-text)" }
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
                      maxLength={12_000}
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
                ) : m.role === "assistant" ? (
                  <AskPulseAnswer content={m.content} incidents={m.cited} onViewOnMap={onViewOnMap} />
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
              maxLength={12_000}
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

      {historyOpen && (
        <div className="absolute inset-0 z-30 flex flex-col" style={{ background: "var(--panel-bg)" }}>
          <div
            className="shrink-0 px-3 py-3 flex items-center gap-2 border-b"
            style={{ borderColor: "var(--panel-border)" }}
          >
            <button
              type="button"
              onClick={() => setHistoryOpen(false)}
              className="p-1 rounded-lg"
              style={{ color: "var(--panel-text-secondary)" }}
              aria-label="Back to chat"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-bold" style={{ color: "var(--panel-text)" }}>
              Chat history
            </span>
            <span className="text-[11px]" style={{ color: "var(--panel-text-muted)" }}>
              {threads.length}
            </span>
            <button
              type="button"
              onClick={() => setHistoryOpen(false)}
              className="ml-auto p-1 rounded-lg"
              style={{ color: "var(--panel-text-muted)" }}
              aria-label="Close history"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="shrink-0 px-3 py-2 border-b" style={{ borderColor: "var(--panel-border)" }}>
            <div
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5"
              style={{ background: "var(--panel-input-bg)", border: "1px solid var(--panel-border)" }}
            >
              <Search className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--panel-text-muted)" }} />
              <input
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                placeholder="Search chats"
                className="flex-1 bg-transparent outline-none text-sm min-w-0"
                style={{ color: "var(--panel-text)" }}
                aria-label="Search chats"
              />
              {historyQuery && (
                <button
                  type="button"
                  onClick={() => setHistoryQuery("")}
                  aria-label="Clear search"
                  style={{ color: "var(--panel-text-muted)" }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
            {historyList.length === 0 ? (
              <p className="text-sm text-center py-10" style={{ color: "var(--panel-text-muted)" }}>
                {historyQuery ? "No chats match your search." : "No chats yet."}
              </p>
            ) : (
              historyList.map((t) => {
                const isOpen = openTabIds.includes(t.id);
                const userMsgs = t.messages.filter((m) => m.role === "user").length;
                return (
                  <div
                    key={t.id}
                    className="group flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer hover:bg-white/5"
                    style={t.id === activeId ? { background: "rgba(59,130,246,0.12)" } : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => openTab(t.id)}
                      className="flex flex-1 min-w-0 items-center gap-2 text-left"
                      aria-current={t.id === activeId ? "page" : undefined}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-sm" style={{ color: "var(--panel-text)" }}>
                          {t.title}
                        </div>
                        <div className="text-[11px] truncate" style={{ color: "var(--panel-text-muted)" }}>
                          {shortWhen(t.updatedAt)} · {userMsgs} msg{userMsgs === 1 ? "" : "s"}
                          {isOpen ? " · open" : ""}
                        </div>
                      </div>
                      {loadingThreads.has(t.id) && (
                        <span
                          className="shrink-0 w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"
                          aria-label="Generating"
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteThread(t.id);
                      }}
                      className="shrink-0 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-red-500/15"
                      style={{ color: "var(--panel-text-muted)" }}
                      aria-label="Delete chat"
                      title="Delete chat"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
