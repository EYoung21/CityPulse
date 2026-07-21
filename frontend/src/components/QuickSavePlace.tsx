"use client";

import { useEffect, useRef, useState } from "react";
import { Bookmark, Check, X, Home, Briefcase, Star, MapPin, Plus, Loader2 } from "lucide-react";
import {
  CATEGORY_LABELS,
  SavedPlaceLimitError,
  useSavedDestinations,
  type SavedCategory,
} from "@/hooks/useSavedDestinations";
import { requestUpgrade } from "@/lib/upgrade";
import { useAuth } from "@/contexts/AuthContext";

interface Props {
  lat: number;
  lng: number;
  /** Reverse-geocoded label, used as the default name and for proximity
   *  detection against existing saves. */
  suggestedName?: string;
  /** Optional auto-focus on mount (defaults to false to avoid yanking
   *  focus into the dropped-pin card on every long-press). */
  autoFocus?: boolean;
}

/** Inline "Save place" form with name editing and list assignment.
 *  Surfaces the full saved-destinations API in one tap rather than
 *  forcing the user to open the sidebar to rename or organize.
 *
 *  The component opens collapsed (one-row CTA) and expands inline
 *  when tapped — keeps the dropped-pin card vertically compact when
 *  not in use.
 *
 *  Categories: Home/Work/Favorite/Custom. When the user picks Custom,
 *  a secondary list picker (with a "+ New list" inline creator) lets
 *  them drop the pin straight into the right bucket. */
export default function QuickSavePlace({
  lat,
  lng,
  suggestedName,
  autoFocus = false,
}: Props) {
  const { canSave, addDestination, lists, createList, destinations, canAddCustom, customCount, freeLimit } = useSavedDestinations();
  const { signInWithGoogle } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const [open, setOpen] = useState(autoFocus);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<SavedCategory>("custom");
  const [listId, setListId] = useState<string | null>(null);
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Refresh the suggested name if the parent re-geocodes (long-press
  // → server returns address). Keeps the field in sync without
  // clobbering edits the user has already typed.
  useEffect(() => {
    if (!open) return;
    const fallback = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    setName((current) => {
      const isUntouched =
        current === "" ||
        current === fallback ||
        // If the user only ever saw a coords placeholder, replace it
        // with the new label.
        /^\d+\.\d+,\s*-?\d+\.\d+$/.test(current);
      return isUntouched ? (suggestedName?.trim() || fallback) : current;
    });
  }, [suggestedName, lat, lng, open]);

  useEffect(() => {
    if (open && autoFocus) inputRef.current?.focus();
  }, [open, autoFocus]);

  // Detect a near-duplicate save so we can warn the user before
  // creating noise in their list. Tolerance ~1m at the equator.
  const duplicate = destinations.find(
    (d) => Math.abs(d.lat - lat) < 1e-5 && Math.abs(d.lng - lng) < 1e-5
  );

  if (!canSave) {
    // Guests (anonymous / signed-out) can't persist saves — saving is
    // gated on a real, non-anonymous account by the Firestore rules. So
    // this button launches sign-in (Google popup, keeping the user on the
    // map with their dropped pin intact) rather than dead-ending. Once
    // signed in, `canSave` flips true and the normal save form renders.
    return (
      <button
        type="button"
        disabled={signingIn}
        onClick={async () => {
          setSigningIn(true);
          try {
            await signInWithGoogle();
          } catch {
            /* popup closed / blocked — detailed error surfaces via AuthContext */
          } finally {
            setSigningIn(false);
          }
        }}
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-60"
        style={{
          background: "rgba(59,130,246,0.10)",
          color: "#3b82f6",
          border: "1px solid rgba(59,130,246,0.35)",
        }}
        title="Sign in to save places across devices"
      >
        {signingIn ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bookmark className="w-4 h-4" />}
        {signingIn ? "Signing in…" : "Sign in to save places"}
      </button>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
        style={{
          background: duplicate ? "rgba(59,130,246,0.10)" : "var(--panel-input-bg)",
          color: duplicate ? "#3b82f6" : "var(--panel-text)",
          border: `1px solid ${duplicate ? "rgba(59,130,246,0.35)" : "var(--panel-border)"}`,
        }}
      >
        <Bookmark className="w-4 h-4" />
        {duplicate ? `Saved · ${duplicate.name}` : "Save this place"}
      </button>
    );
  }

  const handleSave = async () => {
    const trimmed = name.trim().slice(0, 80);
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      let assignList = listId;
      // Inline list creation: persist the new list before saving so
      // the destination can be linked to it in a single round-trip.
      if (category === "custom" && creatingList && newListName.trim()) {
        const id = await createList(newListName.trim());
        if (id) assignList = id;
      }
      await addDestination(
        trimmed,
        lat,
        lng,
        category,
        category === "custom" ? assignList : null
      );
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        setOpen(false);
        setCreatingList(false);
        setNewListName("");
      }, 1400);
    } catch (e) {
      if (e instanceof SavedPlaceLimitError) {
        // Surface the global Pro upgrade modal — page.tsx listens.
        // We don't auto-collapse the inline form so the user can
        // upgrade and immediately retry the save without retyping.
        requestUpgrade(e.feature);
      } else {
        throw e;
      }
    } finally {
      setBusy(false);
    }
  };

  const catBtn = (cat: SavedCategory, Icon: typeof Home, color: string) => {
    const active = category === cat;
    return (
      <button
        key={cat}
        type="button"
        onClick={() => setCategory(cat)}
        aria-pressed={active}
        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-colors"
        style={{
          background: active ? `${color}22` : "var(--panel-input-bg)",
          color: active ? color : "var(--panel-text-secondary)",
          border: `1px solid ${active ? `${color}66` : "var(--panel-border)"}`,
        }}
      >
        <Icon className="w-3.5 h-3.5" />
        {CATEGORY_LABELS[cat]}
      </button>
    );
  };

  return (
    <div
      className="rounded-lg p-2.5 space-y-2"
      style={{ background: "var(--panel-input-bg)", border: "1px solid var(--panel-border)" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--panel-text-muted)" }}>
          Save this place
        </span>
        <button
          type="button"
          onClick={() => { setOpen(false); setCreatingList(false); }}
          className="p-0.5 rounded -m-0.5"
          style={{ color: "var(--panel-text-muted)" }}
          aria-label="Close save dialog"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <input
        ref={inputRef}
        type="text"
        aria-label="Saved place name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name this place"
        maxLength={80}
        className="w-full px-2 py-1.5 rounded-md text-xs focus:outline-none focus:ring-1"
        style={{
          background: "var(--panel-bg)",
          color: "var(--panel-text)",
          border: "1px solid var(--panel-border)",
        }}
        onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); }}
      />

      <div className="flex items-center gap-1">
        {catBtn("home", Home, "#22c55e")}
        {catBtn("work", Briefcase, "#3b82f6")}
        {catBtn("favorite", Star, "#f59e0b")}
        {catBtn("custom", MapPin, "#94a3b8")}
      </div>

      {!canAddCustom && (category === "favorite" || category === "custom") && (
        <p
          className="text-[10px] leading-snug"
          style={{ color: "#a855f7" }}
        >
          You&rsquo;ve saved {customCount}/{freeLimit} places on the free
          tier. Upgrade to Pro for unlimited saves.
        </p>
      )}

      {category === "custom" && (
        <div className="space-y-1.5">
          <p className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
            Add to list (optional)
          </p>
          {!creatingList ? (
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setListId(null)}
                aria-pressed={listId === null}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px]"
                style={{
                  background: listId === null ? "rgba(148,163,184,0.20)" : "var(--panel-bg)",
                  color: listId === null ? "var(--panel-text)" : "var(--panel-text-secondary)",
                  border: "1px solid var(--panel-border)",
                }}
              >
                Uncategorized
              </button>
              {lists.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setListId(l.id)}
                  aria-pressed={listId === l.id}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px]"
                  style={{
                    background: listId === l.id
                      ? `${l.color || "#a855f7"}22`
                      : "var(--panel-bg)",
                    color: listId === l.id
                      ? (l.color || "#a855f7")
                      : "var(--panel-text-secondary)",
                    border: `1px solid ${listId === l.id ? `${l.color || "#a855f7"}66` : "var(--panel-border)"}`,
                  }}
                >
                  {l.name}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setCreatingList(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px]"
                style={{
                  background: "var(--panel-bg)",
                  color: "var(--panel-text-secondary)",
                  border: "1px dashed var(--panel-border)",
                }}
              >
                <Plus className="w-3 h-3" />
                New list
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                type="text"
                aria-label="New list name"
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                placeholder="List name"
                maxLength={60}
                className="flex-1 px-2 py-1 rounded-md text-[11px] focus:outline-none focus:ring-1"
                style={{
                  background: "var(--panel-bg)",
                  color: "var(--panel-text)",
                  border: "1px solid var(--panel-border)",
                }}
              />
              <button
                type="button"
                onClick={() => { setCreatingList(false); setNewListName(""); }}
                className="px-2 py-1 rounded-md text-[10px]"
                style={{ color: "var(--panel-text-muted)" }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy || !name.trim()}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50"
          style={{
            background: saved ? "rgba(34,197,94,0.18)" : "rgba(59,130,246,0.18)",
            color: saved ? "#22c55e" : "#3b82f6",
            border: `1px solid ${saved ? "rgba(34,197,94,0.45)" : "rgba(59,130,246,0.45)"}`,
          }}
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : saved ? (
            <Check className="w-3.5 h-3.5" />
          ) : (
            <Bookmark className="w-3.5 h-3.5" />
          )}
          {saved ? "Saved" : busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
