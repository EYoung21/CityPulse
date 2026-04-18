"use client";

/** Keyboard-shortcut cheat sheet, opened with `?` (Shift+/) and
 *  closed with Escape or a click on the backdrop.
 *
 *  Why ship this:
 *    - Discoverability — most users don't know about `?` for help, but
 *      power users immediately try it on any new web app
 *    - It's also the natural place to surface other shortcuts as the
 *      app grows (currently only a handful are wired)
 *
 *  Implementation notes:
 *    - We listen on `window` for the `?` keypress so it works regardless
 *      of focus, but bail out when the active element is a text input
 *      or contenteditable to avoid stealing typed `?` characters
 *    - The component renders nothing when closed, so the listener has
 *      a tiny constant cost
 *    - Shortcut definitions live in this file — adding a new one is a
 *      single edit, no global registry needed yet
 */

import { useEffect, useState, useMemo } from "react";
import { X, Keyboard } from "lucide-react";

interface Shortcut {
  /** Visible label for the action. */
  label: string;
  /** Each entry is one key — the renderer joins with "+" / "or". */
  keys: string[];
  /** Optional alternate combo (e.g. `?` and `Shift+/` for the same action). */
  altKeys?: string[];
  /** Group header — keeps sections scannable. */
  group: "Navigation" | "Search" | "Map" | "General";
}

const SHORTCUTS: Shortcut[] = [
  { group: "General",    label: "Show this help",                keys: ["?"] },
  { group: "General",    label: "Close panel / dialog",          keys: ["Esc"] },
  { group: "Search",     label: "Focus search box",              keys: ["/"], altKeys: ["Ctrl", "K"] },
  { group: "Search",     label: "Clear search",                  keys: ["Esc"] },
  { group: "Navigation", label: "Recenter on my location",       keys: ["L"] },
  { group: "Navigation", label: "Toggle follow-me mode",         keys: ["F"] },
  { group: "Map",        label: "Cycle basemap style",           keys: ["B"] },
  { group: "Map",        label: "Toggle layers menu",            keys: ["M"] },
  { group: "Map",        label: "Toggle saved-places overlay",   keys: ["S"] },
  { group: "Map",        label: "Toggle nearby POIs",            keys: ["N"] },
];

export default function KeyboardShortcutsHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept when typing — the search box and any input
      // should still receive `?` as a literal character.
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      // Open on `?` (Shift+/ on US layout). Some non-US keyboards
      // produce `?` differently, so accept either the resolved key or
      // the raw Shift+/ combo.
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Group shortcuts for display — useMemo because SHORTCUTS is module-
  // constant and we don't want the .reduce running on every render.
  const grouped = useMemo(() => {
    const out: Record<string, Shortcut[]> = {};
    for (const s of SHORTCUTS) {
      out[s.group] ||= [];
      out[s.group].push(s);
    }
    return out;
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      <div
        className="relative w-full max-w-md max-h-[80vh] overflow-y-auto rounded-2xl shadow-2xl"
        style={{
          background: "var(--panel-bg)",
          border: "1px solid var(--panel-border)",
        }}
      >
        <div
          className="sticky top-0 px-5 py-3 flex items-center justify-between"
          style={{
            background: "var(--panel-bg)",
            borderBottom: "1px solid var(--panel-border)",
          }}
        >
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4" style={{ color: "var(--panel-text-muted)" }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--panel-text)" }}>
              Keyboard shortcuts
            </h2>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="p-1 rounded-md hover:bg-white/10 transition-colors"
            aria-label="Close shortcuts"
          >
            <X className="w-4 h-4" style={{ color: "var(--panel-text-muted)" }} />
          </button>
        </div>
        <div className="px-5 py-3 space-y-4">
          {Object.entries(grouped).map(([group, items]) => (
            <div key={group}>
              <h3
                className="text-[10px] font-semibold uppercase tracking-wider mb-1.5"
                style={{ color: "var(--panel-text-muted)" }}
              >
                {group}
              </h3>
              <ul className="space-y-1">
                {items.map((s) => (
                  <li key={s.label} className="flex items-center justify-between gap-3 py-1">
                    <span className="text-xs" style={{ color: "var(--panel-text)" }}>
                      {s.label}
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      <KeyCombo keys={s.keys} />
                      {s.altKeys && (
                        <>
                          <span className="text-[10px]" style={{ color: "var(--panel-text-muted)" }}>
                            or
                          </span>
                          <KeyCombo keys={s.altKeys} />
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div
          className="px-5 py-2.5 text-[10px] text-center"
          style={{
            color: "var(--panel-text-muted)",
            borderTop: "1px solid var(--panel-border)",
          }}
        >
          Press <KeyCombo keys={["?"]} inline /> any time to toggle this panel.
        </div>
      </div>
    </div>
  );
}

function KeyCombo({ keys, inline = false }: { keys: string[]; inline?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 ${inline ? "align-middle mx-0.5" : ""}`}>
      {keys.map((k, i) => (
        <span
          key={`${k}-${i}`}
          className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded text-[10px] font-mono font-semibold"
          style={{
            background: "var(--panel-input-bg)",
            border: "1px solid var(--panel-input-border)",
            color: "var(--panel-text)",
            boxShadow: "0 1px 0 rgba(0,0,0,0.3)",
          }}
        >
          {k}
        </span>
      ))}
    </span>
  );
}
