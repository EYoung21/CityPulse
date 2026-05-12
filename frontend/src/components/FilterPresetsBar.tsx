"use client";

import { useEffect, useRef, useState } from "react";
import { Bookmark, BookmarkPlus, Trash2, Check, X, ChevronDown } from "lucide-react";
import {
  loadPresets,
  addPreset,
  removePreset,
  subscribePresets,
  type FilterPreset,
} from "@/lib/filter-presets";

interface Props {
  /** Current selected categories (Set of severity_category strings).
   *  Empty = "All". */
  activeCats: Set<string>;
  /** Current time-filter window in hours. */
  timeFilterHours: number;
  /** Apply a saved preset — restores both `activeCats` and the
   *  time window in one call. */
  onApply: (cats: Set<string>, timeFilterHours: number) => void;
}

/** Compact preset selector that lives next to the category pills.
 *  Renders as a single "Presets" pill that, when tapped, opens a
 *  popover with each saved preset (one-tap apply, x to delete) plus a
 *  "Save current view" row that captures the active filters as a new
 *  preset. The popover never blocks the underlying map taps because
 *  it sits inside the existing top-pill container's pointer-events
 *  layer. */
export default function FilterPresetsBar({
  activeCats,
  timeFilterHours,
  onApply,
}: Props) {
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPresets(loadPresets());
    return subscribePresets(setPresets);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Click-outside dismissal — mirrors the layers-menu pattern in
    // page.tsx so the UX feels consistent.
    const onDoc = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setNaming(false);
        setName("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    addPreset({
      name: trimmed,
      cats: [...activeCats],
      timeFilterHours,
    });
    setNaming(false);
    setName("");
  };

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
      style={{ pointerEvents: "auto" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3.5 md:px-4 py-2 md:py-2.5 rounded-full text-xs md:text-sm font-medium transition-all backdrop-blur-md shadow-lg"
        style={{
          background: open ? "rgba(168,85,247,0.15)" : "var(--pill-bg)",
          border: `1px solid ${open ? "rgba(168,85,247,0.40)" : "var(--pill-border)"}`,
          color: open ? "#a855f7" : "var(--pill-text)",
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Saved filter presets"
      >
        <Bookmark className="w-4 h-4 md:w-4.5 md:h-4.5" />
        <span className="hidden md:inline">Presets</span>
        {presets.length > 0 && (
          <span className="text-[11px] font-mono opacity-80">{presets.length}</span>
        )}
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full mt-1.5 left-0 w-64 max-w-[calc(100vw-1.5rem)] rounded-xl shadow-2xl backdrop-blur-xl p-2"
          style={{
            background: "var(--panel-bg)",
            border: "1px solid var(--panel-border)",
            zIndex: 1100,
          }}
        >
          {presets.length === 0 ? (
            <p
              className="text-[11px] leading-snug px-2 py-1.5"
              style={{ color: "var(--panel-text-muted)" }}
            >
              No saved presets yet. Pick categories + a time window above, then tap{" "}
              <span className="font-semibold inline-flex items-center gap-0.5">
                <BookmarkPlus className="w-3 h-3" /> Save current view
              </span>
              .
            </p>
          ) : (
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {presets.map((p) => (
                <div
                  key={p.id}
                  className="group flex items-center gap-1.5 rounded-lg px-2 py-1.5"
                  style={{ background: "var(--panel-input-bg)" }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onApply(new Set(p.cats), p.timeFilterHours);
                      setOpen(false);
                    }}
                    className="flex-1 min-w-0 text-left"
                    role="menuitem"
                  >
                    <p
                      className="text-xs font-semibold truncate"
                      style={{ color: "var(--panel-text)" }}
                      title={p.name}
                    >
                      {p.name}
                    </p>
                    <p
                      className="text-[9px] truncate"
                      style={{ color: "var(--panel-text-muted)" }}
                    >
                      {p.cats.length === 0 ? "All categories" : `${p.cats.length} categor${p.cats.length === 1 ? "y" : "ies"}`}
                      {" · "}
                      {p.timeFilterHours === 0
                        ? "Live"
                        : p.timeFilterHours < 24
                          ? `${p.timeFilterHours}h`
                          : p.timeFilterHours < 168
                            ? `${Math.round(p.timeFilterHours / 24)}d`
                            : `${Math.round(p.timeFilterHours / 168)}w`}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => removePreset(p.id)}
                    className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: "var(--panel-text-muted)" }}
                    aria-label={`Delete preset ${p.name}`}
                    title="Delete preset"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="h-px my-1.5" style={{ background: "var(--panel-border)" }} />

          {!naming ? (
            <button
              type="button"
              onClick={() => setNaming(true)}
              className="w-full flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold"
              style={{
                background: "rgba(168,85,247,0.10)",
                color: "#a855f7",
                border: "1px solid rgba(168,85,247,0.28)",
              }}
            >
              <BookmarkPlus className="w-3 h-3" />
              Save current view
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                  else if (e.key === "Escape") {
                    setNaming(false);
                    setName("");
                  }
                }}
                maxLength={32}
                placeholder="Preset name"
                className="flex-1 min-w-0 rounded-md px-2 py-1.5 text-[11px] outline-none focus:ring-1 focus:ring-purple-500/40"
                style={{
                  background: "var(--panel-input-bg)",
                  border: "1px solid var(--panel-input-border)",
                  color: "var(--panel-text)",
                }}
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={!name.trim()}
                className="w-7 h-7 rounded-md inline-flex items-center justify-center disabled:opacity-40"
                style={{
                  background: "rgba(168,85,247,0.18)",
                  color: "#a855f7",
                }}
                aria-label="Save preset"
              >
                <Check className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => { setNaming(false); setName(""); }}
                className="w-7 h-7 rounded-md inline-flex items-center justify-center"
                style={{ color: "var(--panel-text-muted)" }}
                aria-label="Cancel"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
