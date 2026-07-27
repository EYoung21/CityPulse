"use client";

/**
 * Keyword scanner watches — Pro feature that pings you whenever a
 * given word/phrase shows up in the live transcript.
 *
 * Lives inside the AlertsInbox settings drawer alongside PushSettings
 * because mentally it's "another notification preference," not a
 * separate surface. The list is intentionally read-only for free
 * users so they can see what they'd get with Pro before paying.
 *
 * The phrase syntax mirrors the backend:
 *   shooting          → substring match (fires on "shooting" in any context)
 *   "shots fired"     → exact phrase, word-bounded
 *
 * We surface the phrase syntax inline so users discover it without
 * having to read docs.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Radio, Trash2, Lock, AlertTriangle, Crown } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { getAuth } from "firebase/auth";
import { getFirebaseApp, isFirebaseConfigured } from "@/lib/firebase";
import { getCurrentCity } from "@/lib/pulse-cities";
import {
  createKeywordWatch,
  deleteKeywordWatch,
  listKeywordWatches,
  updateKeywordWatch,
  type KeywordWatch,
} from "@/lib/api";
import { KEYWORD_PUSH_AVAILABLE } from "@/lib/feature-availability";

async function getToken(): Promise<string | null> {
  if (!isFirebaseConfigured()) return null;
  try {
    const u = getAuth(getFirebaseApp()).currentUser;
    if (!u || u.isAnonymous) return null;
    return await u.getIdToken();
  } catch {
    return null;
  }
}

function EnabledKeywordWatchSettings() {
  const { user, isPro } = useAuth();
  const [watches, setWatches] = useState<KeywordWatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [maxWatches, setMaxWatches] = useState(25);
  const [newKeyword, setNewKeyword] = useState("");
  const [scopeCurrent, setScopeCurrent] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const token = await getToken();
    if (!token) {
      setWatches([]);
      setLoading(false);
      return;
    }
    try {
      const r = await listKeywordWatches(token);
      setWatches(r.watches);
      setMaxWatches(r.maxWatches);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load watches");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, user]);

  const onCreate = async () => {
    setError(null);
    const trimmed = newKeyword.trim();
    if (!trimmed) return;
    if (!isPro) {
      setError("Pro subscription required");
      return;
    }
    const token = await getToken();
    if (!token) {
      setError("Sign in to create keyword watches");
      return;
    }
    setCreating(true);
    try {
      await createKeywordWatch(token, {
        keyword: trimmed,
        city: scopeCurrent ? getCurrentCity().slug : "",
      });
      setNewKeyword("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create watch");
    } finally {
      setCreating(false);
    }
  };

  const onToggle = async (w: KeywordWatch) => {
    setError(null);
    const token = await getToken();
    if (!token) return;
    try {
      await updateKeywordWatch(token, w.id, { active: !w.active });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    }
  };

  const onDelete = async (w: KeywordWatch) => {
    setError(null);
    const token = await getToken();
    if (!token) return;
    try {
      await deleteKeywordWatch(token, w.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  if (!user || user.isAnonymous) {
    return (
      <div className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
        Sign in to set up keyword incident alerts.
      </div>
    );
  }

  const atLimit = watches.length >= maxWatches;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--panel-text)" }}
        >
          <Radio className="w-3.5 h-3.5" /> Keyword incident alerts
          {!isPro && (
            <span
              className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] normal-case tracking-normal"
              style={{
                background: "rgba(245,158,11,0.12)",
                color: "#d97706",
                border: "1px solid rgba(245,158,11,0.35)",
              }}
            >
              <Crown className="w-2.5 h-2.5" /> Pro
            </span>
          )}
        </h4>
        <span className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
          {watches.length}/{maxWatches}
        </span>
      </div>

      <p className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
        Get a push when a phrase appears in a new public incident report. Use
        plain words for substring match, or wrap an exact phrase in quotes:{" "}
        <code>&quot;shots fired&quot;</code>.
      </p>

      <div className="flex items-stretch gap-1.5">
        <input
          type="text"
          aria-label="Incident keyword alert"
          value={newKeyword}
          onChange={(e) => setNewKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !creating) {
              e.preventDefault();
              void onCreate();
            }
          }}
          placeholder={isPro ? "shooting, my street, &quot;shots fired&quot;" : "Pro required"}
          disabled={!isPro || atLimit || creating}
          maxLength={64}
          className="flex-1 text-xs px-2 py-1.5 rounded outline-none disabled:opacity-50"
          style={{
            background: "var(--panel-input-bg)",
            border: "1px solid var(--panel-input-border)",
            color: "var(--panel-text)",
          }}
        />
        <button
          type="button"
          onClick={onCreate}
          disabled={!isPro || atLimit || creating || newKeyword.trim().length < 2}
          className="px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 disabled:opacity-40"
          style={{
            background: isPro ? "rgba(59,130,246,0.15)" : "rgba(148,163,184,0.15)",
            color: isPro ? "#3b82f6" : "var(--panel-text-muted)",
            border: `1px solid ${isPro ? "rgba(59,130,246,0.35)" : "rgba(148,163,184,0.25)"}`,
          }}
        >
          {creating ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : isPro ? (
            <Plus className="w-3 h-3" />
          ) : (
            <Lock className="w-3 h-3" />
          )}
          Add
        </button>
      </div>

      <label className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
        <input
          type="checkbox"
          checked={scopeCurrent}
          onChange={(e) => setScopeCurrent(e.target.checked)}
          disabled={!isPro}
          className="w-3 h-3"
        />
        Only this city ({getCurrentCity().name})
      </label>

      {loading ? (
        <div className="flex items-center gap-2 py-2 text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
          <Loader2 className="w-3 h-3 animate-spin" /> Loading watches…
        </div>
      ) : watches.length === 0 ? (
        <p className="text-[10px] py-1" style={{ color: "var(--panel-text-muted)" }}>
          No keyword watches yet.
        </p>
      ) : (
        <div className="space-y-1">
          {watches.map((w) => (
            <div
              key={w.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded"
              style={{
                background: "var(--panel-bg)",
                border: "1px solid var(--panel-border)",
                opacity: w.active ? 1 : 0.55,
              }}
            >
              <Radio
                className="w-3 h-3 shrink-0"
                style={{ color: w.active ? "#3b82f6" : "var(--panel-text-muted)" }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate" style={{ color: "var(--panel-text)" }}>
                  {w.keyword}
                </p>
                <p className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
                  {w.city ? `${w.city} only` : "All cities"}
                  {w.lastFiredMs > 0 && ` · last ping ${new Date(w.lastFiredMs).toLocaleString()}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onToggle(w)}
                className="text-[10px] px-2 py-0.5 rounded"
                style={{
                  background: "var(--panel-input-bg)",
                  color: "var(--panel-text-muted)",
                  border: "1px solid var(--panel-border)",
                }}
                title={w.active ? "Pause this watch" : "Resume this watch"}
              >
                {w.active ? "On" : "Off"}
              </button>
              <button
                type="button"
                onClick={() => onDelete(w)}
                className="text-rose-400 hover:text-rose-500"
                title="Delete this watch"
                aria-label={`Delete watch ${w.keyword}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-1 text-[10px]" style={{ color: "#ef4444" }}>
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

export default function KeywordWatchSettings() {
  if (!KEYWORD_PUSH_AVAILABLE) {
    return (
      <div
        className="flex items-start gap-2 rounded-lg p-2.5 text-[10px]"
        style={{ color: "var(--panel-text-muted)", background: "var(--panel-input-bg)" }}
      >
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        Keyword push alerts are temporarily paused while the retired ingestion
        backend is replaced.
      </div>
    );
  }

  return <EnabledKeywordWatchSettings />;
}
